package ai

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// Dense notes can contain many small Markdown blocks within one context chunk.
// The existing 256 KiB reply limit remains the primary response memory bound.
const MaxBlockChanges = 4096

// IDs belong to a frozen draft version and source offset, never a screen position.
// Text slices borrow the snapshot, which owns their lifetime.
type Block struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Start int    `json:"-"`
	End   int    `json:"-"`
}
type BlockChange struct {
	ID     string `json:"id"`
	Before string `json:"before"`
	After  string `json:"after"`
}

func (c *BlockChange) UnmarshalJSON(data []byte) error {
	var fields struct {
		ID     *string `json:"id"`
		Before *string `json:"before"`
		After  *string `json:"after"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(&fields) != nil || fields.ID == nil || fields.Before == nil || fields.After == nil {
		return errors.New("changes require id, before and after strings")
	}
	c.ID, c.Before, c.After = *fields.ID, *fields.Before, *fields.After
	return nil
}

func editableBlocks(source string, offset, version int) ([]Block, error) {
	// Whole-note legacy calls have the same parser work bounds as planned jobs.
	if strings.Count(source, "\n") > maxPlanLines {
		return nil, errors.New("note has too many lines to process safely")
	}
	for line := range strings.SplitSeq(source, "\n") {
		quotes := 0
		for _, r := range line {
			if r == '>' {
				quotes++
				if quotes > 64 {
					return nil, errors.New("markdown nesting is too deep; share a smaller selection")
				}
			} else if r != ' ' && r != '\t' {
				break
			}
		}
	}
	root := blockParser().ParseStringSource(source)
	starts := []int{0}
	// Each top-level Markdown node is an edit unit. Lists, nested containers,
	// fences and tables stay together; unrelated short paragraphs never merge.
	for node := root.FirstChild(); node != nil; node = node.NextSibling() {
		pos := node.Pos()
		if pos < 0 || pos > len(source) {
			return nil, errors.New("could not locate Markdown blocks safely")
		}
		pos = strings.LastIndexByte(source[:pos], '\n') + 1
		if pos > starts[len(starts)-1] {
			starts = append(starts, pos)
		}
	}
	// Leading blank lines are layout, not an independent editable passage.
	if len(starts) > 1 {
		start, end := blockBodyBounds(source[:starts[1]])
		if start == end {
			starts = append(starts[:1], starts[2:]...)
		}
	}
	blocks := make([]Block, 0, len(starts))
	for i, start := range starts {
		end := len(source)
		if i+1 < len(starts) {
			end = starts[i+1]
		}
		blocks = append(blocks, Block{ID: "b" + strconv.Itoa(version) + "_" + strconv.Itoa(offset+start), Text: source[start:end], Start: start, End: end})
	}
	return blocks, nil
}

func blockHunks(source, scope string, blocks []Block, changes []BlockChange) ([]Hunk, error) {
	if len(changes) == 0 {
		return []Hunk{}, nil
	}
	if scope == "none" {
		return nil, errors.New("model proposed changes without sharing permission")
	}
	if len(changes) > MaxBlockChanges {
		return nil, errors.New("model returned too many block changes")
	}
	byID := make(map[string]int, len(blocks))
	for i, b := range blocks {
		byID[b.ID] = i
	}
	grouped := make(map[int][]BlockChange, len(changes))
	for _, change := range changes {
		index, ok := byID[change.ID]
		if !ok {
			return nil, errors.New("model returned a change that does not match the current shared draft; no edits were accepted")
		}
		grouped[index] = append(grouped[index], change)
	}
	replacements := make(map[int]string, len(grouped))
	size := len(source)
	for index, edits := range grouped {
		updated, err := applyCompactChanges(blocks[index].Text, edits)
		if err != nil {
			return nil, err
		}
		text := preserveBlockWhitespace(blocks[index].Text, updated)
		if len(text) > MaxContext {
			return nil, errors.New("proposed passage exceeds 256 KiB")
		}
		replacements[index] = text
		size += len(text) - len(blocks[index].Text)
	}
	if size > MaxSnapshot {
		return nil, errors.New("proposed draft exceeds 1 MiB")
	}
	hunks := []Hunk{}
	coarse := false
	budget := maxReplacementCells
	cursor := 0
	for i, block := range blocks {
		if block.Start != cursor || block.End < block.Start || block.End > len(source) || source[block.Start:block.End] != block.Text {
			return nil, errors.New("editable snapshot is inconsistent")
		}
		if text, changed := replacements[i]; changed && !coarse {
			local, err := blockReplacementHunks(block.Text, text, scope, &budget)
			if err != nil {
				return nil, err
			}
			for _, h := range local {
				h.Start += block.Start
				h.End += block.Start
				if len(hunks) > 0 && hunks[len(hunks)-1].Start == h.Start {
					last := &hunks[len(hunks)-1]
					last.Before += h.Before
					last.After += h.After
					last.End = h.End
				} else {
					hunks = append(hunks, h)
				}
			}
			if len(hunks) > 128 {
				coarse = true
				hunks = nil
			}
		}
		cursor = block.End
	}
	if cursor != len(source) {
		return nil, errors.New("editable snapshot is incomplete")
	}
	if coarse {
		var result strings.Builder
		result.Grow(size)
		for i, block := range blocks {
			if text, ok := replacements[i]; ok {
				result.WriteString(text)
			} else {
				result.WriteString(block.Text)
			}
		}
		return focusedReplacement(source, result.String()), nil
	}
	return hunks, nil
}

// Internal editing capabilities retain the existing review seams. Provider
// responses exclusively use Changes; legacy Go callers can still supply edits.
func replyHunks(source, scope string, blocks []Block, reply Reply) ([]Hunk, error) {
	if reply.Changes != nil {
		if len(reply.Edits) > 0 || reply.Replacement != nil {
			return nil, errors.New("model mixed block changes with legacy edits")
		}
		return blockHunks(source, scope, blocks, reply.Changes)
	}
	if reply.Replacement != nil {
		if len(reply.Edits) > 0 {
			return nil, errors.New("model mixed replacement and edits")
		}
		return replacementHunks(source, *reply.Replacement, scope)
	}
	return ValidateEdits(source, scope, reply.Edits)
}

// Preserve independently reviewable line edits when line counts match. Unequal
// shapes use bounded line LCS; all blocks share one work budget for the section.
func blockReplacementHunks(before, after, scope string, budget *int) ([]Hunk, error) {
	lines := strings.Count(before, "\n") + 1
	if lines <= 1024 && lines == strings.Count(after, "\n")+1 {
		left, right := strings.SplitAfter(before, "\n"), strings.SplitAfter(after, "\n")
		hunks := []Hunk{}
		offset := 0
		for i, line := range left {
			if line != right[i] {
				original, updated := line, right[i]
				ending := ""
				if strings.HasSuffix(original, "\r\n") && strings.HasSuffix(updated, "\r\n") {
					ending = "\r\n"
				} else if strings.HasSuffix(original, "\n") && strings.HasSuffix(updated, "\n") {
					ending = "\n"
				}
				original = strings.TrimSuffix(original, ending)
				updated = strings.TrimSuffix(updated, ending)
				// Keep line context in the proposal so follow-ups to @labels
				// identify meaningful text, including insertion-only changes.
				hunks = append(hunks, Hunk{ID: ID(), Start: offset, End: offset + len(original), Before: original, After: updated})
				if len(hunks) > 128 {
					return focusedReplacement(before, after), nil
				}
			}
			offset += len(line)
		}
		return hunks, nil
	}
	return replacementHunksWithBudget(before, after, scope, budget)
}

func blockBodyBounds(text string) (int, int) {
	space := func(c byte) bool { return c == ' ' || c == '\t' || c == '\r' || c == '\n' }
	start, end := 0, len(text)
	for start < end && space(text[start]) {
		start++
	}
	for end > start && space(text[end-1]) {
		end--
	}
	return start, end
}

// Outer whitespace belongs to the snapshot. Providers may omit or reproduce it;
// neither choice can remove separators or change the original edge indentation.
// Internal Markdown whitespace remains editable as part of the block body.
func preserveBlockWhitespace(original, replacement string) string {
	start, end := blockBodyBounds(original)
	nextStart, nextEnd := blockBodyBounds(replacement)
	if original[:start] == replacement[:nextStart] && original[end:] == replacement[nextEnd:] {
		return replacement
	}
	return original[:start] + replacement[nextStart:nextEnd] + original[end:]
}
