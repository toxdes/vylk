package ai

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestWrongBlockAnchorFeedbackRequiresModelCorrection(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	first := "I has a clear idea.\n\n"
	phrase := "the worse mistake I think I've done"
	source := first + phrase
	blocks := []Block{{ID: "b0_6686", Text: first, End: len(first)}, {ID: "b0_7369", Text: phrase, Start: len(first), End: len(source)}}
	input, _ := json.Marshal(providerInput("note", blocks, "fix grammar", nil, nil))
	messages := []Message{{Role: "system", Content: SystemPrompt}, {Role: "user", Content: string(input)}}
	changes := []BlockChange{{ID: blocks[0].ID, Before: "I has", After: "I have"}, {ID: blocks[0].ID, Before: phrase, After: "the worst mistake I think I've made"}}
	original := append([]BlockChange(nil), changes...)
	calls := 0
	reply, err := m.CompleteWithFeedback(context.Background(), Configuration{}, messages, "note", "session", "turn", func(_ context.Context, _ Configuration, next []Message, _, _, _ string) (Reply, error) {
		calls++
		if calls == 1 {
			return Reply{Changes: changes}, nil
		}
		var input struct {
			Feedback struct {
				Anchor anchorDiagnostic `json:"anchor_error"`
			} `json:"validation_feedback"`
		}
		if err := json.Unmarshal([]byte(next[len(next)-1].Content), &input); err != nil {
			t.Fatal(err)
		}
		if input.Feedback.Anchor != (anchorDiagnostic{ChangeIndex: 1, ID: blocks[0].ID, Before: phrase, MatchingBlockID: blocks[1].ID}) {
			t.Fatal(input.Feedback.Anchor)
		}
		if !reflect.DeepEqual(changes, original) {
			t.Fatal("diagnostic silently relocated the rejected edit")
		}
		corrected := append([]BlockChange(nil), changes...)
		corrected[1].ID = blocks[1].ID
		return Reply{Changes: corrected}, nil
	}, func(reply Reply) error {
		hunks, err := blockHunks(source, "note", blocks, reply.Changes)
		if err != nil && hunks != nil {
			t.Fatal("published a partial response")
		}
		return err
	})
	if err != nil || calls != 2 || reply.Changes[1].ID != blocks[1].ID || !reflect.DeepEqual(changes, original) {
		t.Fatal(reply, calls, err)
	}
}

func TestAnchorHintsRequireOneExactEditableOccurrence(t *testing.T) {
	for _, tc := range []struct {
		name, scope, before, want string
		blocks                    []Block
	}{
		{"unique", "note", "Café 🙂", "B2", []Block{{ID: "B1", Text: "elsewhere"}, {ID: "B2", Text: "Café 🙂."}}},
		{"multiple blocks", "note", "word", "", []Block{{ID: "B2", Text: "word"}, {ID: "B3", Text: "word"}}},
		{"multiple occurrences", "note", "word", "", []Block{{ID: "B2", Text: "word and word"}}},
		{"overlapping occurrences", "note", "aba", "", []Block{{ID: "B2", Text: "ababa"}}},
		{"wrong case", "note", "Word", "", []Block{{ID: "B2", Text: "word"}}},
		{"different punctuation", "note", "I've", "", []Block{{ID: "B2", Text: "I’ve"}}},
		{"already matches target", "note", "word", "", []Block{{ID: "B1", Text: "word"}, {ID: "B2", Text: "word"}}},
		{"no shared scope", "none", "word", "", []Block{{ID: "B2", Text: "word"}}},
		{"empty", "note", "", "", []Block{{ID: "B2", Text: "word"}}},
		{"pending proposed text", "note", "word", "@14", []Block{{ID: "@14", Text: "word"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, _ := json.Marshal(map[string]any{
				"scope": tc.scope, "blocks": tc.blocks,
				"originals_read_only":  []Block{{ID: "@15", Text: tc.before}},
				"read_only_references": []Reference{{Ref: "@16", Before: tc.before, After: tc.before}},
				"read_only_after":      tc.before, "previous_review": []Hunk{{Before: tc.before}},
			})
			var envelope map[string]json.RawMessage
			_ = json.Unmarshal(data, &envelope)
			change := BlockChange{ID: "B1", Before: tc.before, After: "new"}
			diagnostic := diagnoseAnchor(envelope, []BlockChange{change}, &anchorError{change: change, missing: true, reason: "missing"})
			if diagnostic == nil || diagnostic.MatchingBlockID != tc.want || diagnostic.Before != tc.before || diagnostic.ID != "B1" {
				t.Fatal(diagnostic)
			}
		})
	}
}

func TestAmbiguousAnchorsIdentifyTheRejectedChangeWithoutRelocationHint(t *testing.T) {
	change := BlockChange{ID: "B1", Before: "go", After: "went"}
	_, err := applyCompactChanges("go and go", []BlockChange{change})
	diagnostic := diagnoseAnchor(nil, []BlockChange{change}, err)
	if diagnostic == nil || diagnostic.ID != "B1" || diagnostic.Before != "go" || diagnostic.MatchingBlockID != "" {
		t.Fatal(diagnostic, err)
	}
	if diagnoseAnchor(nil, []BlockChange{change}, errors.New("transport error")) != nil {
		t.Fatal("invented anchor feedback for unrelated error")
	}
}
