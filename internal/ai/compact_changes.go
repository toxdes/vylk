package ai

import (
	"errors"
	"sort"
	"strings"
)

// Retain the exact rejected edit for correction feedback, without searching or
// relocating anything during validation.
type anchorError struct {
	change  BlockChange
	missing bool
	reason  string
}

func (e *anchorError) Error() string { return e.reason }

// All anchors refer to the same frozen target. Resolve and validate every span
// before building a result; a later edit cannot repair or change an earlier one.
func applyCompactChanges(original string, changes []BlockChange) (string, error) {
	type span struct {
		start, end int
		after      string
	}
	spans := make([]span, 0, len(changes))
	size := len(original)
	for _, change := range changes {
		if !ValidText(change.Before, MaxContext) || !ValidText(change.After, MaxContext) {
			return "", errors.New("model returned invalid replacement text")
		}
		start, end := 0, len(original)
		if change.Before == "" {
			bodyStart, bodyEnd := blockBodyBounds(original)
			if bodyStart != bodyEnd || len(changes) != 1 {
				return "", errors.New("empty before is allowed only for one insertion into an empty target; use an exact unique anchor otherwise")
			}
		} else {
			start = strings.Index(original, change.Before)
			if start < 0 {
				return "", &anchorError{change: change, missing: true, reason: "before must match exact text in the identified block or pending suggestion; copy Markdown, whitespace and punctuation exactly"}
			}
			// Index from start+1 also detects overlapping occurrences.
			if strings.Contains(original[start+1:], change.Before) {
				return "", &anchorError{change: change, reason: "before occurs more than once in its target; include enough adjacent unchanged text to make it unique"}
			}
			end = start + len(change.Before)
		}
		spans = append(spans, span{start, end, change.After})
		size += len(change.After) - (end - start)
	}
	if size > MaxContext {
		return "", errors.New("proposed passage exceeds 256 KiB")
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end || spans[i].start == spans[i-1].start {
			return "", errors.New("replacement anchors overlap or repeat; merge overlapping corrections and refer only to the original target")
		}
	}
	var result strings.Builder
	result.Grow(max(0, size))
	cursor := 0
	for _, s := range spans {
		result.WriteString(original[cursor:s.start])
		result.WriteString(s.after)
		cursor = s.end
	}
	result.WriteString(original[cursor:])
	return result.String(), nil
}
