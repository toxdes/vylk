package ai

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// Match the browser merge policy's bounded line-LCS strategy. At most ~2 MiB
// of table storage and one million comparisons; large inputs fall back to one
// exact, focused replacement instead of unbounded quadratic work.
const maxReplacementCells = 1000000

func replacementHunks(source, replacement, scope string) ([]Hunk, error) {
	budget := maxReplacementCells
	return replacementHunksWithBudget(source, replacement, scope, &budget)
}

func replacementHunksWithBudget(source, replacement, scope string, budget *int) ([]Hunk, error) {
	if scope == "none" {
		return nil, errors.New("model proposed a replacement without sharing permission")
	}
	if !ValidText(replacement, MaxContext) {
		return nil, errors.New("replacement exceeds 256 KiB or contains invalid text")
	}
	if source == replacement {
		return []Hunk{}, nil
	}
	rows, columns := strings.Count(source, "\n")+1, strings.Count(replacement, "\n")+1
	// Check before splitting: newline-heavy notes otherwise allocate large line
	// arrays just to discard them. Division also avoids overflow on 32-bit hosts.
	if rows+1 > *budget/(columns+1) {
		return focusedReplacement(source, replacement), nil
	}
	*budget -= (rows + 1) * (columns + 1)
	left, right := strings.SplitAfter(source, "\n"), strings.SplitAfter(replacement, "\n")
	width := columns + 1
	table := make([]uint16, (rows+1)*width)
	for i := rows - 1; i >= 0; i-- {
		for j := columns - 1; j >= 0; j-- {
			if left[i] == right[j] {
				table[i*width+j] = table[(i+1)*width+j+1] + 1
			} else {
				table[i*width+j] = max(table[(i+1)*width+j], table[i*width+j+1])
			}
		}
	}
	hunks := []Hunk{}
	i, j, offset := 0, 0, 0
	for i < rows || j < columns {
		if i < rows && j < columns && left[i] == right[j] {
			offset += len(left[i])
			i++
			j++
			continue
		}
		start, rightStart := offset, j
		for i < rows || j < columns {
			if i < rows && j < columns && left[i] == right[j] {
				break
			}
			if j < columns && (i == rows || table[i*width+j+1] > table[(i+1)*width+j]) {
				j++
			} else {
				offset += len(left[i])
				i++
			}
		}
		before, after := source[start:offset], strings.Join(right[rightStart:j], "")
		// Trimming shared prefixes/suffixes makes grammar hunks readable while
		// positions, rather than model-generated anchors, identify repeated text.
		change := focusedReplacement(before, after)
		if len(change) != 0 {
			h := change[0]
			h.Start += start
			h.End += start
			hunks = append(hunks, h)
		}
		if len(hunks) > 128 {
			return focusedReplacement(source, replacement), nil
		}
	}
	return hunks, nil
}

func focusedReplacement(before, after string) []Hunk {
	if before == after {
		return []Hunk{}
	}
	start := 0
	for start < len(before) && start < len(after) && before[start] == after[start] {
		start++
	}
	for start > 0 && ((start < len(before) && !utf8.RuneStart(before[start])) || (start < len(after) && !utf8.RuneStart(after[start]))) {
		start--
	}
	endBefore, endAfter := len(before), len(after)
	for endBefore > start && endAfter > start && before[endBefore-1] == after[endAfter-1] {
		endBefore--
		endAfter--
	}
	for endBefore < len(before) && !utf8.RuneStart(before[endBefore]) {
		endBefore++
		endAfter++
	}
	return []Hunk{{ID: ID(), Start: start, End: endBefore, Before: before[start:endBefore], After: after[start:endAfter]}}
}
