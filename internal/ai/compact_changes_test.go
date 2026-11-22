package ai

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompactAnchorsAreFrozenUniqueAndNonOverlapping(t *testing.T) {
	for _, tc := range []struct {
		name, original, want string
		edits                []BlockChange
		invalid              bool
	}{
		{"multiple corrections", "He go home. She walk away.", "He goes home. She walks away.", []BlockChange{{Before: "He go", After: "He goes"}, {Before: "She walk", After: "She walks"}}, false},
		{"frozen positions", "one two", "two three", []BlockChange{{Before: "one", After: "two"}, {Before: "two", After: "three"}}, false},
		{"generated anchor", "one two", "", []BlockChange{{Before: "one", After: "new"}, {Before: "new", After: "three"}}, true},
		{"repeated", "go and go", "", []BlockChange{{Before: "go", After: "went"}}, true},
		{"overlapping occurrences", "ababa", "", []BlockChange{{Before: "aba", After: "x"}}, true},
		{"disambiguated", "go and go", "went and go", []BlockChange{{Before: "go and", After: "went and"}}, false},
		{"overlapping edits", "one two", "", []BlockChange{{Before: "one two", After: "new"}, {Before: "two", After: "three"}}, true},
		{"duplicate edits", "one", "", []BlockChange{{Before: "one", After: "new"}, {Before: "one", After: "new"}}, true},
		{"empty insertion", "", "new", []BlockChange{{Before: "", After: "new"}}, false},
		{"ambiguous insertion", "one", "", []BlockChange{{Before: "", After: "new"}}, true},
		{"anchored insertion", "one two", "one new two", []BlockChange{{Before: "one", After: "one new"}}, false},
		{"deletion", "one two", "one", []BlockChange{{Before: "one two", After: "one"}}, false},
		{"unicode and CRLF", "Café 🙂\r\nHe go.", "Café 🙂\r\nHe goes.", []BlockChange{{Before: "He go", After: "He goes"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := applyCompactChanges(tc.original, tc.edits)
			if (err != nil) != tc.invalid || (!tc.invalid && got != tc.want) {
				t.Fatal(got, err)
			}
		})
	}
}

func TestCompactChangesAreScopedToOneBlockAndReconstructReview(t *testing.T) {
	source := "He go home. She walk away.\n\nHe go home.\n"
	blocks, _ := editableBlocks(source, 0, 0)
	edits := []BlockChange{{ID: blocks[0].ID, Before: "He go", After: "He goes"}, {ID: blocks[0].ID, Before: "She walk", After: "She walks"}, {ID: blocks[1].ID, Before: "He go", After: "He went"}}
	hunks, err := blockHunks(source, "note", blocks, edits)
	if err != nil {
		t.Fatal(err)
	}
	result := source
	for i := len(hunks) - 1; i >= 0; i-- {
		h := hunks[i]
		result = result[:h.Start] + h.After + result[h.End:]
	}
	if result != "He goes home. She walks away.\n\nHe went home.\n" {
		t.Fatal(result)
	}
	invalid := append(edits, BlockChange{ID: blocks[1].ID, Before: "not in this block", After: "wrong"})
	if partial, err := blockHunks(source, "note", blocks, invalid); err == nil || partial != nil {
		t.Fatal("published a partial correction", partial, err)
	}
}

func TestCompactWireRejectsFormerWholeBlockShape(t *testing.T) {
	for _, raw := range []string{
		`{"id":"b0_0","text":"changed"}`,
		`{"id":"b0_0","before":"old","after":"new","text":"new"}`,
		`{"id":"b0_0","before":null,"after":"new"}`,
		`{"id":"b0_0","before":"old"}`,
	} {
		var c BlockChange
		if json.Unmarshal([]byte(raw), &c) == nil {
			t.Fatal("accepted another response shape", raw)
		}
	}
}

func TestCompactProofreadingPayloadAvoidsReprintingParagraphs(t *testing.T) {
	original := strings.Repeat("This clear sentence needs no changes. ", 80) + "He go home."
	legacy, _ := json.Marshal(map[string]any{"answer": ReviewChangesAnswer, "changes": []any{map[string]string{"id": "b0_0", "text": strings.Replace(original, "He go", "He goes", 1)}}})
	compact, _ := json.Marshal(map[string]any{"answer": ReviewChangesAnswer, "changes": []BlockChange{{ID: "b0_0", Before: "He go", After: "He goes"}}})
	if len(compact)*10 >= len(legacy) {
		t.Fatal("compact edit did not materially reduce output", len(compact), len(legacy))
	}
	t.Logf("reply bytes: whole paragraph=%d compact=%d", len(legacy), len(compact))
}
