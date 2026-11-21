package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompatibleCapacitySelectsModelAndConservativeEndpointLimits(t *testing.T) {
	for _, tc := range []struct {
		body            string
		context, output int
	}{
		{`{"data":[{"id":"other","context_length":4096},{"id":"selected","context_length":60000,"max_output_tokens":2048}]}`, 60000, 2048},
		{`{"data":{"id":"selected","context_length":128000,"endpoints":[{"context_length":60000,"max_completion_tokens":8192},{"context_length":32000,"max_completion_tokens":2048}]}}`, 32000, 2048},
		{`{"data":{"id":"selected","context_length":128000,"top_provider":{"context_length":60000,"max_completion_tokens":1024}}}`, 60000, 1024},
		{`{"data":{"id":"selected","context_length":4096,"max_completion_tokens":null}}`, 4096, 0},
		{`{"data":{"id":"other","context_length":4096,"max_output_tokens":2048}}`, 0, 0},
		{`{"data":{"id":"selected","context_length":-1,"max_output_tokens":2147483647}}`, 0, 0},
	} {
		got := advertisedCapacity([]byte(tc.body), "selected")
		if got.Tokens != tc.context || got.OutputTokens != tc.output {
			t.Fatal(tc.body, got)
		}
	}
}

func TestOllamaCapacityUsesActiveWindowRatherThanArchitectureMaximum(t *testing.T) {
	p := NewProvider()
	defer p.Close()
	active := 4096
	requests := map[string]int{}
	p.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
		requests[r.URL.Path]++
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatal("credentials changed")
		}
		body := ""
		switch r.URL.Path {
		case "/proxy/v1/models":
			if r.Method != "GET" {
				t.Fatal(r.Method)
			}
			body = `{"data":[{"id":"selected"}]}`
		case "/proxy/api/show":
			var input map[string]string
			if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&input) != nil || len(input) != 1 || input["model"] != "selected" {
				t.Fatal("metadata includes note text")
			}
			body = `{"capabilities":["completion","thinking"],"details":{"family":"qwen35"},"model_info":{"general.architecture":"qwen35","qwen35.context_length":262144},"parameters":"num_ctx 60000\nnum_predict 2048"}`
		case "/proxy/api/ps":
			if r.Method != "GET" || r.ContentLength > 0 {
				t.Fatal("invalid ps request")
			}
			data, _ := json.Marshal(map[string]any{"models": []any{map[string]any{"model": "other", "context_length": 1024}, map[string]any{"model": "selected", "context_length": active}}})
			body = string(data)
		default:
			t.Fatalf("unexpected request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	c := Configuration{URL: "http://localhost:11434/proxy/v1", Model: "selected", Key: "secret"}
	first := p.modelCapacity(context.Background(), c, false)
	if first.Tokens != 4096 || first.OutputTokens != 2048 {
		t.Fatal(first)
	}
	active = 60000
	if got := p.modelCapacity(context.Background(), c, false); got.Tokens != 4096 {
		t.Fatal("cache bypassed", got)
	}
	p.RefreshCapacity(context.Background(), c)
	if got := p.modelCapacity(context.Background(), c, false); got.Tokens != 60000 {
		t.Fatal("Test did not refresh active context", got)
	}
	if requests["/proxy/api/show"] != 1 || requests["/proxy/api/ps"] != 2 || requests["/proxy/v1/models"] != 2 {
		t.Fatal(requests)
	}
}

func TestOllamaUnloadedMaximumIsNotAnEffectiveWindow(t *testing.T) {
	var metadata ollamaMetadata
	_ = json.Unmarshal([]byte(`{"model_info":{"general.architecture":"qwen35","qwen35.context_length":262144},"parameters":"num_predict -1\nnum_ctx -1"}`), &metadata)
	got := ollamaConfiguredCapacity(metadata)
	if got.Tokens != 0 || got.OutputTokens != 0 || got.MaximumTokens != 262144 {
		t.Fatal(got)
	}
	metadata.Parameters = "num_ctx 1000000\nnum_predict 2048"
	got = ollamaConfiguredCapacity(metadata)
	if got.Tokens != 262144 || got.OutputTokens != 2048 {
		t.Fatal(got)
	}
	if got := ollamaRunningContext([]byte(`{"models":[{"model":"other","context_length":4096}]}`), "selected"); got != 0 {
		t.Fatal(got)
	}
}

func TestPlanningFitsCompleteInputAndReplyForSmallWindows(t *testing.T) {
	source := strings.Repeat("He go home. Keep the facts and voice.\n\n", 180)
	for _, capacity := range []modelContext{{Tokens: 4096}, {Tokens: 60000, OutputTokens: 512}, {Tokens: 128000, OutputTokens: 8192}} {
		shared := source
		if capacity.OutputTokens == 512 {
			shared = strings.Repeat("He go home. Keep the facts and voice.\n\n", 60)
		}
		p := Plan{neighbourBytes: 768, source: shared, prompt: "Fix grammar", scope: "note"}
		if err := p.prepareSections(capacity); err != nil {
			t.Fatal(capacity, err)
		}
		combined := ""
		for i, r := range p.ranges {
			combined += shared[r.Start:r.End]
			input := estimatedInputTokens(p.messages(i))
			output := estimatedReplyTokens(p.blocks[i])
			if input+max(outputReserve(capacity), output) > capacity.Tokens {
				t.Fatal("input plus reply exceeds window", capacity, input, output)
			}
			if capacity.OutputTokens > 0 && output > capacity.OutputTokens {
				t.Fatal("reply exceeds advertised output limit", output)
			}
		}
		if combined != shared {
			t.Fatal("planning lost or duplicated source text")
		}
	}
}

func TestPlanningAccountsForHistoryAndKeepsMarkdownAtomic(t *testing.T) {
	p := Plan{neighbourBytes: 768, source: "Small paragraph.", scope: "note", prompt: "Fix grammar", history: []Message{{Role: "assistant", Content: strings.Repeat("long history ", 2000)}}}
	if err := p.prepareSections(modelContext{Tokens: 4096}); err == nil {
		t.Fatal("ignored conversation history")
	}
	p = Plan{neighbourBytes: 768, source: "```\n" + strings.Repeat("long code line\n", 100) + "```\n", scope: "note", prompt: "Fix grammar"}
	if err := p.prepareSections(modelContext{Tokens: 4096, OutputTokens: 512}); err == nil {
		t.Fatal("split protected Markdown to fit")
	}
}

func TestKnownCapacityPacksAFittingNoteWithoutTheOldSourceTarget(t *testing.T) {
	source := strings.Repeat("Careful editors preserve meaningful punctuation throughout every original Markdown paragraph.\n\n", 100)
	old, err := planSections(source, sectionTokens)
	if err != nil || len(old) < 2 {
		t.Fatal("fixture did not exercise old split", old, err)
	}
	p := Plan{neighbourBytes: 768, source: source, scope: "note", prompt: "Fix grammar"}
	capacity := modelContext{Tokens: 16384, OutputTokens: 16384}
	if err := p.prepareSections(capacity); err != nil {
		t.Fatal(err)
	}
	t.Logf("fitting 1,000-word fixture: source-target sections=%d capacity-packed sections=%d", len(old), p.Sections)
	if p.Sections != 1 || p.ranges[0] != (Section{0, len(source)}) || sectionText(p.messages(0)) != source {
		t.Fatal("fitting note was split or changed", p.ranges)
	}
	if estimatedInputTokens(p.messages(0))+max(outputReserve(capacity), estimatedReplyTokens(p.blocks[0])) > capacity.Tokens {
		t.Fatal("packing exceeded complete request capacity")
	}
	unknown := Plan{neighbourBytes: 768, source: source, scope: "note", prompt: "Fix grammar"}
	if err := unknown.prepareSections(modelContext{}); err != nil || unknown.Sections != len(old) {
		t.Fatal("unknown limits changed defaults", err, unknown.Sections)
	}
	large := Plan{neighbourBytes: 768, source: strings.Repeat(source, 3), scope: "note", prompt: "Fix grammar"}
	if err := large.prepareSections(modelContext{Tokens: 128000}); err != nil {
		t.Fatal(err)
	}
	for _, r := range large.ranges {
		if r.End-r.Start > maxSectionBytes {
			t.Fatal("removed source byte bound", r)
		}
	}
	dense := Plan{neighbourBytes: 768, source: strings.Repeat("&\n\n", 5000), scope: "note", prompt: "Fix grammar"}
	if err := dense.prepareSections(modelContext{Tokens: 1 << 20}); err != nil {
		t.Fatal(err)
	}
	for _, blocks := range dense.blocks {
		_, bytes := estimatedReplyBudget(blocks)
		if len(blocks) > MaxBlockChanges || bytes > MaxContext {
			t.Fatal("packing exceeded reply work bounds", len(blocks), bytes)
		}
	}
}

func TestEditSectionsMatchParallelCallsWithinBounds(t *testing.T) {
	paragraph := "Careful editors preserve meaningful punctuation throughout every original Markdown paragraph.\n\n"
	for _, tc := range []struct {
		name     string
		repeats  int
		parallel int
		sections int
	}{
		{"small note stays whole", 100, 4, 1},
		{"one call per parallel slot", 800, 4, 4},
		{"serial calls use the largest sections", 800, 1, 3},
		{"tiny sections are never created", 800, 8, 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := strings.Repeat(paragraph, tc.repeats)
			p := Plan{neighbourBytes: 768, source: source, scope: "note", prompt: "Fix grammar", parallel: tc.parallel}
			if err := p.prepareSections(modelContext{Tokens: 1 << 20}); err != nil {
				t.Fatal(err)
			}
			if p.Sections != tc.sections {
				t.Fatalf("sections=%d, want %d", p.Sections, tc.sections)
			}
			combined := ""
			for _, r := range p.ranges {
				combined += source[r.Start:r.End]
				if tokens := estimatedInputTokens([]Message{{Content: source[r.Start:r.End]}}); tokens > maxSectionTokens {
					t.Fatal("section outside size bounds", tokens)
				}
			}
			if combined != source {
				t.Fatal("planning lost or duplicated source text")
			}
		})
	}
}

func TestPlanningCapacityPrefersConfiguredThenReportedThenDefault(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"reported","context_length":65536},{"id":"silent"}]}`))
	}))
	defer server.Close()
	p := NewProvider()
	for _, tc := range []struct {
		model      string
		configured int
		want       int
	}{
		{"reported", 0, 65536}, {"reported", 200000, 200000}, {"silent", 0, DefaultContextTokens}, {"silent", 4096, 4096},
	} {
		got := p.planningCapacity(context.Background(), Configuration{URL: server.URL, Model: tc.model, ContextTokens: tc.configured}).Tokens
		if got != tc.want {
			t.Fatalf("%s configured=%d: got %d, want %d", tc.model, tc.configured, got, tc.want)
		}
	}
}

func TestConfigurationLimitsValidateAndCapConcurrency(t *testing.T) {
	base := Configuration{Name: "n", URL: "https://example.com/v1", Model: "m"}
	for _, tc := range []struct {
		context, concurrency int
		ok                   bool
	}{{0, 0, true}, {2048, 1, true}, {MaxContextTokens, MaxConcurrency, true}, {1024, 0, false}, {MaxContextTokens + 1, 0, false}, {0, -1, false}, {0, MaxConcurrency + 1, false}} {
		c := base
		c.ContextTokens, c.Concurrency = tc.context, tc.concurrency
		if err := c.Validate(); (err == nil) != tc.ok {
			t.Fatal(tc, err)
		}
	}
	m := NewManager(4)
	defer m.Stop()
	for configured, want := range map[int]int{0: 4, 2: 2, 8: 4} {
		if got := m.parallel(Configuration{Concurrency: configured}); got != want {
			t.Fatalf("configured %d: got %d, want %d", configured, got, want)
		}
	}
}
