package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestEditableBlocksPreserveMarkdownContainersAndBytes(t *testing.T) {
	source := "# Café 🙂\r\n\r\n" + strings.Repeat("Paragraph with emphasis *here*.\r\n\r\n", 20) + "- first\r\n  - nested\r\n\r\n  ```go\r\n  x := 1\r\n  ```\r\n- second\r\n\r\n| A | B |\r\n|---|---|\r\n| x | y |\r\n\r\n```\r\n# not a heading\r\n\r\ninside fence\r\n```\r\n"
	blocks, err := editableBlocks(source, 23, 7)
	if err != nil {
		t.Fatal(err)
	}
	var joined strings.Builder
	seen := map[string]bool{}
	for _, block := range blocks {
		joined.WriteString(block.Text)
		if seen[block.ID] || !strings.HasPrefix(block.ID, "b7_") || block.Text != source[block.Start:block.End] {
			t.Fatal("invalid block", block)
		}
		seen[block.ID] = true
		for _, protected := range []string{"  - nested\r\n\r\n  ```go\r\n  x := 1\r\n  ```", "| A | B |\r\n|---|---|\r\n| x | y |", "```\r\n# not a heading\r\n\r\ninside fence\r\n```"} {
			start := strings.Index(source, protected)
			end := start + len(protected)
			if block.Start > start && block.Start < end || block.End > start && block.End < end {
				t.Fatal("split Markdown container")
			}
		}
	}
	if joined.String() != source {
		t.Fatal("snapshot bytes changed")
	}
	other, err := editableBlocks(source, 23, 8)
	if err != nil || other[0].ID == blocks[0].ID {
		t.Fatal("IDs reused across draft versions")
	}
	dense, _ := editableBlocks(strings.Repeat("x\n\n", 5400), 0, 0)
	if len(dense) != 5400 {
		t.Fatal("independent paragraphs were grouped", len(dense))
	}
}

func TestBlockChangesUseOnlyFrozenIDsAndKeepUnchangedText(t *testing.T) {
	source := strings.Repeat("Unchanged text. ", 24) + "\n\nHe go home.\r\n\r\n" + strings.Repeat("Leave this alone. ", 24) + "\n"
	blocks, err := editableBlocks(source, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	var changed Block
	for _, block := range blocks {
		if strings.Contains(block.Text, "He go") {
			changed = block
		}
	}
	changes := []BlockChange{{ID: changed.ID, Before: "He go", After: "He goes"}}
	hunks, err := blockHunks(source, "note", blocks, changes)
	if err != nil || len(hunks) == 0 {
		t.Fatal(hunks, err)
	}
	result := source
	for i := len(hunks) - 1; i >= 0; i-- {
		h := hunks[i]
		result = result[:h.Start] + h.After + result[h.End:]
	}
	if result != strings.ReplaceAll(source, "He go", "He goes") {
		t.Fatal("unrelated text changed")
	}
	for _, invalid := range [][]BlockChange{
		{{ID: "b2_0", Before: "He go", After: "stale"}},
		{{ID: "b3_999999", Before: "He go", After: "outside section"}},
		{changes[0], changes[0]},
		{{ID: changed.ID, Before: changed.Text, After: "bad\x00text"}},
	} {
		if _, err := blockHunks(source, "note", blocks, invalid); err == nil {
			t.Fatal("accepted invalid changes", invalid)
		}
	}
	if _, err := blockHunks(source, "none", blocks, changes); err == nil {
		t.Fatal("edited without sharing")
	}
	if h, err := blockHunks(source, "note", blocks, []BlockChange{{ID: changed.ID, Before: changed.Text, After: changed.Text}}); err != nil || len(h) != 0 {
		t.Fatal("unchanged block made a diff")
	}
	empty, _ := editableBlocks("", 0, 0)
	if h, err := blockHunks("", "selection", empty, []BlockChange{{ID: empty[0].ID, Before: "", After: "new text"}}); err != nil || len(h) != 1 {
		t.Fatal("insertion failed", err)
	}
}

func TestBlockChangesDecodeStrictlyAndCanDelete(t *testing.T) {
	for _, input := range []string{`{"id":"b0_0"}`, `{"id":null,"text":"x"}`, `{"id":"b0_0","text":null}`, `{"id":"b0_0","text":"x","extra":1}`} {
		var change BlockChange
		if json.Unmarshal([]byte(input), &change) == nil {
			t.Fatal("accepted incomplete change", input)
		}
	}
	blocks, _ := editableBlocks("delete me", 0, 0)
	h, err := blockHunks("delete me", "selection", blocks, []BlockChange{{ID: blocks[0].ID, Before: blocks[0].Text, After: ""}})
	if err != nil || len(h) != 1 || h[0].After != "" {
		t.Fatal(h, err)
	}
}

func BenchmarkEditableBlocks(b *testing.B) {
	source := strings.Repeat("A paragraph of Markdown that usually stays unchanged.\n\n", 180)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := editableBlocks(source, 0, 1); err != nil {
			b.Fatal(err)
		}
	}
}

func TestBlockDiffKeepsLineReviewAndCoalescesBoundaryInsertions(t *testing.T) {
	source := "first\nsecond"
	blocks, _ := editableBlocks(source, 0, 0)
	hunks, err := blockHunks(source, "selection", blocks, []BlockChange{{ID: blocks[0].ID, Before: blocks[0].Text, After: "FIRST\nSECOND"}})
	if err != nil || len(hunks) != 2 || hunks[0].Before != "first" || hunks[1].Before != "second" {
		t.Fatal("line review merged", hunks, err)
	}
	source = "first\nsecond"
	blocks = []Block{{ID: "b0_0", Text: "first\n", Start: 0, End: 6}, {ID: "b0_6", Text: "second", Start: 6, End: 12}}
	hunks, err = blockHunks(source, "selection", blocks, []BlockChange{{ID: "b0_0", Before: "first\n", After: "first\nnew"}, {ID: "b0_6", Before: "second", After: "SECOND"}})
	if err != nil {
		t.Fatal(err)
	}
	result := source
	for i := len(hunks) - 1; i >= 0; i-- {
		h := hunks[i]
		if i > 0 && h.Start == hunks[i-1].Start {
			t.Fatal("ambiguous insertion boundary")
		}
		result = result[:h.Start] + h.After + result[h.End:]
	}
	if result != "first\nnew\nSECOND" {
		t.Fatal("boundary change lost text", result)
	}
}

func TestSectionRejectsIDsFromOtherSectionsWithoutPublishing(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	source := strings.Repeat("He go home.\n\n", 900)
	session, err := m.Create("owner", "note", "note", source, Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := m.PlanTurn(session.ID, "owner", "fix grammar", 0)
	if err != nil || len(plan.blocks) < 2 {
		t.Fatal("expected multiple sections", err)
	}
	foreign := plan.blocks[1][0].ID
	_, err = m.StartJob(session.ID, "owner", plan.ID, 0, func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		var input struct {
			Blocks []Block `json:"blocks"`
		}
		if err := json.Unmarshal([]byte(messages[len(messages)-1].Content), &input); err != nil {
			return Reply{}, err
		}
		block := input.Blocks[0]
		if block.ID == plan.blocks[0][0].ID {
			block.ID = foreign
		}
		return Reply{Answer: "Corrected", Changes: []BlockChange{{ID: block.ID, Before: block.Text, After: strings.ReplaceAll(block.Text, "He go", "He goes")}}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if job := waitJob(t, m, session.ID); job.Status != "failed" {
		t.Fatal("foreign ID accepted", job)
	}
	current, err := m.Metadata(session.ID, "owner")
	if err != nil || current.Draft != source || len(current.Hunks) != 0 {
		t.Fatal("partial results published", err)
	}
}

// Diff reconstruction preserves accepted body changes while the snapshot owns
// each block's outer whitespace. Semantic fidelity remains a separate concern.
func TestBlockDiffReconstructsBodyChangesAndFrozenWhitespace(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n"} {
		source := "# Café 🙂" + newline + newline + strings.Repeat("Keep this original paragraph and its links. ", 10) + newline + newline + "He go home." + newline + newline + strings.Repeat("Another untouched paragraph. ", 12) + newline + newline + "## Next section" + newline
		blocks, err := editableBlocks(source, 0, 4)
		if err != nil {
			t.Fatal(err)
		}
		for mode := 0; mode < 6; mode++ {
			changes := []BlockChange{}
			var expected strings.Builder
			for i, block := range blocks {
				updated := block.Text
				switch mode {
				case 0:
					updated = strings.ReplaceAll(updated, "He go", "He goes")
				case 1:
					updated = strings.ReplaceAll(updated, newline, "")
				case 2:
					if i%2 == 0 {
						updated = ""
					}
				case 3:
					updated = "new text" + newline + updated + newline + "added ending"
				case 4:
					updated = strings.TrimSpace(updated)
				case 5:
					updated = strings.ReplaceAll(updated, "original", "🙂 original é")
				}
				expected.WriteString(preserveBlockWhitespace(block.Text, updated))
				if updated != block.Text {
					changes = append(changes, BlockChange{ID: block.ID, Before: block.Text, After: updated})
				}
			}
			hunks, err := blockHunks(source, "note", blocks, changes)
			if err != nil {
				t.Fatalf("mode %d: %v", mode, err)
			}
			result := source
			for i := len(hunks) - 1; i >= 0; i-- {
				h := hunks[i]
				if h.Before != source[h.Start:h.End] || i > 0 && h.Start < hunks[i-1].End {
					t.Fatal("diff does not match frozen text", mode)
				}
				result = result[:h.Start] + h.After + result[h.End:]
			}
			if result != expected.String() {
				t.Fatalf("mode %d: local diff altered normalized block content", mode)
			}
		}
	}
}

func TestIndependentBlocksRestoreFrozenWhitespace(t *testing.T) {
	source := "  First paragraph.\r\n\r\nSecond paragraph.\n\n## Heading\r\n\r\n"
	blocks, err := editableBlocks(source, 0, 0)
	if err != nil || len(blocks) != 3 {
		t.Fatal("paragraphs and headings must be separate", blocks, err)
	}
	changes := []BlockChange{
		{ID: blocks[0].ID, Before: blocks[0].Text, After: "First corrected paragraph."},
		{ID: blocks[1].ID, Before: blocks[1].Text, After: "Second corrected paragraph.\n\n\n\n"},
		{ID: blocks[2].ID, Before: blocks[2].Text, After: "\n## Updated heading"},
	}
	hunks, err := blockHunks(source, "note", blocks, changes)
	if err != nil {
		t.Fatal(err)
	}
	result := source
	for i := len(hunks) - 1; i >= 0; i-- {
		h := hunks[i]
		result = result[:h.Start] + h.After + result[h.End:]
	}
	want := "  First corrected paragraph.\r\n\r\nSecond corrected paragraph.\n\n## Updated heading\r\n\r\n"
	if result != want {
		t.Fatalf("separators or indentation changed: %q", result)
	}
	list, err := editableBlocks("- first\n  - nested\n- second\n\nNext paragraph.\n", 0, 0)
	if err != nil || len(list) != 2 || !strings.Contains(list[0].Text, "- second") {
		t.Fatal("list container split", list, err)
	}
	padded, err := editableBlocks("\n\nParagraph.\n", 0, 0)
	if err != nil || len(padded) != 1 {
		t.Fatal("leading whitespace became an edit unit", padded, err)
	}
}

func TestWhitespaceOnlyResponsesCannotEraseAParagraphSeparator(t *testing.T) {
	source := "First paragraph.\n\nSecond paragraph.\n"
	blocks, _ := editableBlocks(source, 0, 0)
	hunks, err := blockHunks(source, "note", blocks, []BlockChange{{ID: blocks[0].ID, Before: blocks[0].Text, After: ""}})
	if err != nil {
		t.Fatal(err)
	}
	result := source
	for i := len(hunks) - 1; i >= 0; i-- {
		h := hunks[i]
		result = result[:h.Start] + h.After + result[h.End:]
	}
	if result != "\n\nSecond paragraph.\n" {
		t.Fatal("deleting body altered server-owned layout", result)
	}
}
