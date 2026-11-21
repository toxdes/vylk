package ai

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestSearchCountsEveryMatchAndBoundsResults(t *testing.T) {
	source := strings.Repeat("Teh cat. teh dog. 🙂\n", 30)
	result := searchTool(source, ToolCall{Name: toolSearch, Pattern: "teh", IgnoreCase: true})
	if result.Error != "" || *result.Count != 60 || len(result.Matches) != maxToolMatches {
		t.Fatal(result.Error, *result.Count, len(result.Matches))
	}
	if first := result.Matches[0]; first.Start != 0 || first.End != 3 || first.Line != 1 || !strings.HasPrefix(first.Excerpt, "Teh cat") {
		t.Fatal(first)
	}
	if second := result.Matches[2]; second.Line != 2 {
		t.Fatal("line numbers", second)
	}
	if consonants := searchTool("Rhythm, ok?", ToolCall{Name: toolSearch, Pattern: "[b-df-hj-np-tv-z]", IgnoreCase: true}); *consonants.Count != 7 {
		t.Fatal("consonants", *consonants.Count)
	}
	// Empty matches advance one rune, so they terminate and count every position.
	if empty := searchTool("a🙂b", ToolCall{Name: toolSearch, Pattern: ""}); empty.Error == "" {
		t.Fatal("accepted empty pattern")
	}
	if positions := searchTool("a🙂b", ToolCall{Name: toolSearch, Pattern: "x*"}); *positions.Count != 4 {
		t.Fatal("empty-match positions", *positions.Count)
	}
	if invalid := searchTool(source, ToolCall{Name: toolSearch, Pattern: "(a"}); invalid.Error == "" || invalid.Count != nil {
		t.Fatal("accepted invalid pattern")
	}
	if backreference := searchTool(source, ToolCall{Name: toolSearch, Pattern: `(a)\1`}); backreference.Error == "" {
		t.Fatal("accepted a non-RE2 pattern")
	}
}

func TestReadOutlineAndStatsStayWithinSharedText(t *testing.T) {
	source := "# Title\n\nPara 🙂 one.\n\n```\n# not a heading\n```\n\n## Next ##\nlast line"
	read := readTool(source, ToolCall{Name: toolRead, Start: 15, End: 1 << 30})
	if read.Error != "" || *read.Start != 14 || *read.End != len(source) || read.Truncated {
		t.Fatal("rune-safe clamp", read.Error, *read.Start, *read.End)
	}
	if bad := readTool(source, ToolCall{Name: toolRead, Start: 5, End: 2}); bad.Error == "" {
		t.Fatal("accepted reversed range")
	}
	long := readTool(strings.Repeat("x", 3*maxToolReadBytes), ToolCall{Name: toolRead, End: 3 * maxToolReadBytes})
	if len(*long.Text) != maxToolReadBytes || !long.Truncated {
		t.Fatal("read not bounded")
	}
	headings := outline(source)
	if len(headings) != 2 || headings[0].Text != "Title" || headings[1].Text != "Next" || headings[1].Level != 2 || headings[1].Line != 9 {
		t.Fatal(headings)
	}
	if stats := sharedStats(source); stats.Lines != 10 || stats.Paragraphs != 4 || stats.Words != 16 || stats.Characters != len([]rune(source)) {
		t.Fatal(stats)
	}
}

func TestResponseFormatRequiresOfferedToolsAndKeepsBlockIDs(t *testing.T) {
	request := providerInput("note", []Block{{ID: "b1_0", Text: "x"}}, "count", nil, nil)
	request.offerTools(newTurnTools("x", "note"), textTools)
	first, _ := json.Marshal(request)
	results, _ := json.Marshal(toolEnvelope{Scope: "note", Results: []toolResult{}, Available: []string{}, RoundsLeft: 0})
	for _, tc := range []struct {
		messages []Message
		tools    bool
	}{
		{[]Message{{"user", string(first)}}, true},
		{[]Message{{"user", string(first)}, {"assistant", "{}"}, {"user", string(results)}}, false},
	} {
		var schema struct {
			JSONSchema struct {
				Schema struct {
					Required   []string `json:"required"`
					Properties struct {
						Changes struct {
							Items struct {
								Properties struct {
									ID struct {
										Enum []string `json:"enum"`
									} `json:"id"`
								} `json:"properties"`
							} `json:"items"`
						} `json:"changes"`
						Tools *struct {
							MaxItems int `json:"maxItems"`
						} `json:"tools"`
					} `json:"properties"`
				} `json:"schema"`
			} `json:"json_schema"`
		}
		if err := json.Unmarshal(scopedResponseFormat(tc.messages), &schema); err != nil {
			t.Fatal(err)
		}
		properties := schema.JSONSchema.Schema.Properties
		if (properties.Tools != nil) != tc.tools || (tc.tools && (len(schema.JSONSchema.Schema.Required) != 3 || properties.Tools.MaxItems != maxToolCalls)) {
			t.Fatal("tools schema", tc.tools, schema.JSONSchema.Schema.Required)
		}
		if ids := properties.Changes.Items.Properties.ID.Enum; len(ids) != 1 || ids[0] != "b1_0" {
			t.Fatal("tool results lost editable IDs", ids)
		}
	}
}

// toolProbe records each request envelope a provider fake receives.
type toolProbe struct {
	mu       sync.Mutex
	requests []map[string]json.RawMessage
}

func (p *toolProbe) record(messages []Message) map[string]json.RawMessage {
	var input map[string]json.RawMessage
	_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
	p.mu.Lock()
	p.requests = append(p.requests, input)
	p.mu.Unlock()
	return input
}

func runTurn(t *testing.T, scope, source, prompt string, c Configuration, call SectionCall) (Session, Job) {
	t.Helper()
	m := NewManager(4)
	t.Cleanup(m.Stop)
	s, err := m.Create("owner", "note", scope, source, c)
	if err != nil {
		t.Fatal(err)
	}
	p, err := m.PlanTurn(s.ID, "owner", prompt, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartJob(s.ID, "owner", p.ID, 0, call); err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, m, s.ID)
	current, _ := m.Metadata(s.ID, "owner")
	return current, j
}

func TestSelectionToolsSeeOnlySharedTextAndAdvertiseRounds(t *testing.T) {
	probe := &toolProbe{}
	session, job := runTurn(t, "selection", "a b a", "How many a?", Configuration{}, func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
		input := probe.record(messages)
		if results, ok := input["tool_results"]; ok {
			var parsed []toolResult
			_ = json.Unmarshal(results, &parsed)
			return Reply{Answer: "There are " + strings.Repeat("a", *parsed[0].Count) + " matches."}, nil
		}
		return Reply{Tools: []ToolCall{{Name: toolSearch, Pattern: "a"}}, raw: `{"answer":"","changes":[],"tools":[]}`}, nil
	})
	if job.Status != "completed" || session.Answer != "There are aa matches." || len(probe.requests) != 2 {
		t.Fatal(job, session.Answer, len(probe.requests))
	}
	var first, second struct {
		Tools  []string `json:"tools_available"`
		Rounds int      `json:"tool_rounds_remaining"`
	}
	firstData, _ := json.Marshal(probe.requests[0])
	secondData, _ := json.Marshal(probe.requests[1])
	_ = json.Unmarshal(firstData, &first)
	_ = json.Unmarshal(secondData, &second)
	if first.Rounds != MaxToolRounds || len(first.Tools) != len(textTools) || second.Rounds != MaxToolRounds-1 {
		t.Fatal("rounds not advertised", first, second)
	}
}

func TestToolRoundsRunOutThenRequireAnAnswer(t *testing.T) {
	calls := 0
	session, job := runTurn(t, "note", "short note", "count", Configuration{}, func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
		calls++
		var input struct {
			Tools []string `json:"tools_available"`
		}
		_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
		if len(input.Tools) == 0 {
			return Reply{Answer: "Answered with what I have."}, nil
		}
		return Reply{Tools: []ToolCall{{Name: toolStats}}, raw: `{}`}, nil
	})
	if job.Status != "completed" || calls != MaxToolRounds+1 || session.Answer != "Answered with what I have." {
		t.Fatal(job, calls, session.Answer)
	}
}

func TestScopeNoneOffersNoTools(t *testing.T) {
	probe := &toolProbe{}
	_, job := runTurn(t, "none", "", "hi", Configuration{}, func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
		if _, ok := probe.record(messages)["tools_available"]; ok {
			t.Error("offered tools without shared text")
		}
		return Reply{Tools: []ToolCall{{Name: toolStats}}}, nil
	})
	if job.Status != "failed" || len(probe.requests) != maxCorrectionAttempts+1 {
		t.Fatal("accepted tools without shared text", job, len(probe.requests))
	}
}

func TestRoutingAnswersOrCombinesWithoutEditingSections(t *testing.T) {
	source := strings.Repeat("Careful editors preserve meaningful punctuation throughout every original Markdown paragraph.\n\n", 800)
	for _, tc := range []struct {
		name     string
		window   int
		route    string
		answer   string
		sections bool
	}{
		{"direct tool answer", 1 << 20, toolSearch, "Exact answer.", false},
		{"whole text when it fits", 1 << 20, routeReadWhole, "Whole answer.", false},
		{"combine when it does not fit", 16384, routeCombine, "Combined answer.", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := &toolProbe{}
			session, job := runTurn(t, "note", source, "Summarize", Configuration{ContextTokens: tc.window}, func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
				input := probe.record(messages)
				switch {
				case input["shared_text"] != nil:
					var offered []string
					_ = json.Unmarshal(input["tools_available"], &offered)
					if strings.Contains(string(input["tools_available"]), routeReadWhole) != (tc.window == 1<<20) {
						t.Error("read_whole offered when it does not fit", offered)
					}
					return Reply{Tools: []ToolCall{{Name: tc.route, Pattern: "x"}}, raw: `{}`}, nil
				case input["tool_results"] != nil, input["findings"] != nil:
					return Reply{Answer: tc.answer}, nil
				case strings.Contains(string(input["mode"]), "collect_findings"):
					if !strings.Contains(messages[0].Content, "collect_findings") {
						t.Error("findings request lacks its prompt")
					}
					return Reply{Answer: "A finding."}, nil
				}
				var blocks []Block
				_ = json.Unmarshal(input["blocks"], &blocks)
				if len(blocks) == 0 || tc.route != routeReadWhole {
					t.Error("unexpected request", string(input["request"]), len(blocks))
				}
				return Reply{Answer: tc.answer}, nil
			})
			if job.Status != "completed" || session.Answer != tc.answer || len(session.Hunks) != 0 {
				t.Fatal(job, session.Answer)
			}
			findings := 0
			for _, request := range probe.requests {
				if strings.Contains(string(request["mode"]), "collect_findings") {
					findings++
				}
			}
			if (findings > 1) != tc.sections {
				t.Fatal("findings requests", findings)
			}
		})
	}
}
