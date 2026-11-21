package ai

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestRevisionTargetsExposeOnlyEditableProposedText(t *testing.T) {
	source := "Use nodejs.\n\nKeep *critical* CSS."
	refs := []Reference{
		{Ref: "@14", Status: "pending", Before: "Use nodejs.", After: "Use node.js.", Available: true, EditableHere: true, positioned: true, start: 0, end: 11},
		{Ref: "@15", Status: "pending", Before: "Keep *critical* CSS.", After: "Keep `critical` CSS.", Available: true, positioned: true, start: 13, end: len(source)},
	}
	input := providerInput("note", []Block{{ID: "b0_0", Text: source}}, "redo @14 and @15", []Hunk{{Before: source}}, refs)
	if input.Mode != "revise_suggestions" || len(input.Blocks) != 1 || input.Blocks[0].ID != "@14" || input.Blocks[0].Text != refs[0].After || len(input.Review) != 0 {
		t.Fatal(input)
	}
	if len(input.Originals) != 1 || input.Originals[0].Text != refs[0].Before || len(input.ReadOnlyReferences) != 1 || input.ReadOnlyReferences[0].Ref != "@15" {
		t.Fatal(input)
	}
	for _, ref := range input.References {
		if ref.Before != "" || ref.After != "" {
			t.Fatal("competing pending versions", input)
		}
	}
	if refs[0].After != "Use node.js." {
		t.Fatal("projection mutated validation context")
	}
	data, _ := json.Marshal(input)
	messages := []Message{{Role: "user", Content: string(data)}}
	assertRevisionSchema(t, scopedResponseFormat(messages), []string{"@14"}, false)
	repair, err := correctionMessages(messages, "{}", errors.New("wrong anchor"), nil)
	if err != nil {
		t.Fatal(err)
	}
	assertRevisionSchema(t, scopedResponseFormat(repair), []string{"@14"}, false)
	for _, c := range []Configuration{{StructuredOutput: true, Ollama: true}, {StructuredOutput: true, URL: "https://openrouter.ai/api/v1"}} {
		format, _ := structuredFormat(c, messages)
		assertRevisionSchema(t, format, []string{"@14"}, false)
	}

	// Grammar constraints supplement the strict server validator, never replace it.
	for _, change := range []BlockChange{{ID: "@14", Before: "nodejs", After: "new"}, {ID: "@15", Before: "critical", After: "new"}} {
		if _, _, err := referencedReplyHunks(source, "note", nil, refs, Section{0, 11}, Reply{Changes: []BlockChange{change}}); err == nil {
			t.Fatal("accepted original anchor or out-of-range reference", change)
		}
	}
	hunks, revisions, err := referencedReplyHunks(source, "note", nil, refs, Section{0, 11}, Reply{Changes: []BlockChange{{ID: "@14", Before: "node.js", After: "nodejs"}}})
	if err != nil || len(hunks) != 0 || len(revisions) != 1 || !revisions[0].withdrawn || revisions[0].ref != "@14" {
		t.Fatal(hunks, revisions, err)
	}
}

func TestRevisionWithoutEditableTargetsRequiresNoChanges(t *testing.T) {
	for _, scope := range []string{"note", "none"} {
		input := providerInput(scope, nil, "explain @15", nil, []Reference{{Ref: "@15", Status: "pending", Before: "old", After: "new"}})
		if scope == "none" {
			input.Blocks = []Block{{ID: "@15", Text: "new"}}
		}
		data, _ := json.Marshal(input)
		assertRevisionSchema(t, scopedResponseFormat([]Message{{Role: "user", Content: string(data)}}), nil, true)
	}
}

func TestRevisionPlanScopesEachRequestToItsOwnSuggestion(t *testing.T) {
	m, s, source := pendingReferenceFixture(t)
	plan, err := m.PlanTurn(s.ID, "owner", "redo @1 and @3", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ranges) != 2 {
		t.Fatal("fixture should span separate requests", plan.ranges)
	}
	for i, id := range []string{"@1", "@3"} {
		messages := plan.messages(i)
		var input providerContext
		if err := json.Unmarshal([]byte(messages[len(messages)-1].Content), &input); err != nil {
			t.Fatal(err)
		}
		if len(input.Blocks) != 1 || input.Blocks[0].ID != id || len(input.ReadOnlyReferences) != 1 || input.Before != nil || input.After != nil {
			t.Fatal("revision includes competing editable drafts", input)
		}
		assertRevisionSchema(t, scopedResponseFormat(messages), []string{id}, false)
	}
	if s.Draft != source {
		t.Fatal("planning modified the note")
	}
}

func assertRevisionSchema(t *testing.T, raw json.RawMessage, ids []string, empty bool) {
	t.Helper()
	var format struct {
		JSONSchema struct {
			Schema struct {
				Properties struct {
					Changes struct {
						MaxItems *int `json:"maxItems"`
						Items    struct {
							Properties struct {
								ID struct {
									Enum []string `json:"enum"`
								} `json:"id"`
							} `json:"properties"`
						} `json:"items"`
					} `json:"changes"`
				} `json:"properties"`
			} `json:"schema"`
		} `json:"json_schema"`
	}
	if err := json.Unmarshal(raw, &format); err != nil {
		t.Fatal(err)
	}
	changes := format.JSONSchema.Schema.Properties.Changes
	if !reflect.DeepEqual(changes.Items.Properties.ID.Enum, ids) || empty && (changes.MaxItems == nil || *changes.MaxItems != 0) {
		t.Fatal(string(raw))
	}
}
