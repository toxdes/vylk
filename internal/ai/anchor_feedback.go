package ai

import (
	"encoding/json"
	"errors"
	"strings"
)

type anchorDiagnostic struct {
	ChangeIndex     int    `json:"change_index"`
	ID              string `json:"id"`
	Before          string `json:"before"`
	MatchingBlockID string `json:"matching_block_id,omitempty"`
}

// Diagnostics use only this request's frozen editable blocks. Original wording,
// neighbours, history and other sections must never supply relocation hints.
func diagnoseAnchor(envelope map[string]json.RawMessage, changes []BlockChange, validation error) *anchorDiagnostic {
	var invalid *anchorError
	if !errors.As(validation, &invalid) {
		return nil
	}
	index := -1
	for i, change := range changes {
		if change == invalid.change {
			index = i
			break
		}
	}
	if index < 0 {
		return nil
	}
	diagnostic := &anchorDiagnostic{ChangeIndex: index, ID: invalid.change.ID, Before: invalid.change.Before}
	if !invalid.missing || diagnostic.Before == "" {
		return diagnostic
	}
	var scope string
	var blocks []Block
	if json.Unmarshal(envelope["scope"], &scope) != nil || scope == "none" || json.Unmarshal(envelope["blocks"], &blocks) != nil {
		return diagnostic
	}
	candidate := ""
	for _, block := range blocks {
		start := strings.Index(block.Text, diagnostic.Before)
		if start < 0 {
			continue
		}
		// Searching from start+1 also counts overlapping occurrences.
		if block.ID == diagnostic.ID || candidate != "" || strings.Contains(block.Text[start+1:], diagnostic.Before) {
			return diagnostic
		}
		candidate = block.ID
	}
	diagnostic.MatchingBlockID = candidate
	return diagnostic
}
