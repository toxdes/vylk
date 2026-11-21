package ai

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxProposalHistoryBytes = 512 << 10
const maxProposalReferences = 20 * 512
const maxRequestedReferenceBytes = 128 << 10

type proposalRecord struct {
	status, before, after string
	available             bool
	root, lastRevision    int
}

// Reference identifies an original proposal, never a position to apply blindly.
// Archived positions are intentionally discarded as the accepted draft changes.
type Reference struct {
	Ref          string `json:"ref"`
	Status       string `json:"status"`
	Before       string `json:"before,omitempty"`
	After        string `json:"after,omitempty"`
	Available    bool   `json:"details_available"`
	EditableHere bool   `json:"editable_here"`
	start, end   int
	positioned   bool
}

func (s *Session) archiveSuggestions() { s.archiveHunks(s.Hunks) }

func (s *Session) archiveHunks(hunks []Hunk) {
	for _, h := range hunks {
		n, ok := s.proposalIndex[h.Ref]
		if !ok {
			continue
		}
		record := &s.proposals[n]
		record.status = h.Decision
		if record.status == "" {
			record.status = "superseded"
		}
		cost := len(h.Before) + len(h.After)
		if cost > maxProposalHistoryBytes {
			continue
		}
		// Clone small hunks so they cannot pin an entire old provider response.
		record.before, record.after = strings.Clone(h.Before), strings.Clone(h.After)
		record.available = true
		s.proposalBytes += cost
		s.proposalPayloads = append(s.proposalPayloads, n)
	}
	for s.proposalBytes > maxProposalHistoryBytes && s.payloadHead < len(s.proposalPayloads) {
		record := &s.proposals[s.proposalPayloads[s.payloadHead]]
		s.proposalBytes -= len(record.before) + len(record.after)
		record.before, record.after = "", ""
		record.available = false
		s.payloadHead++
	}
}

func (s *Session) publishSuggestions(hunks []Hunk) error {
	if len(hunks) == 0 {
		return nil
	}
	if len(s.proposals)+len(hunks) > maxProposalReferences {
		return errors.New("change reference limit reached; start a new AI conversation")
	}
	s.archiveSuggestions()
	for i := range hunks {
		hunks[i].Ref = s.allocateProposal(0)
	}
	s.Hunks = hunks
	return nil
}

func referenceWord(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '@'
}

func (s *Session) requestedReferences(prompt string) ([]Reference, error) {
	refs := []Reference{}
	if !strings.Contains(prompt, "@") {
		return refs, nil
	}
	seen := make(map[string]bool)
	bytes := 0
	active := make(map[string]Hunk, len(s.Hunks))
	for _, h := range s.Hunks {
		active[h.Ref] = h
	}
	for offset := 0; offset < len(prompt); {
		relative := strings.IndexByte(prompt[offset:], '@')
		if relative < 0 {
			break
		}
		start := offset + relative
		end := start + 1
		for end < len(prompt) && ((prompt[end] >= '0' && prompt[end] <= '9') || prompt[end] == '.') {
			end++
		}
		offset = end
		if end == start+1 {
			continue
		}
		if start > 0 {
			r, _ := utf8.DecodeLastRuneInString(prompt[:start])
			if referenceWord(r) {
				continue
			}
		}
		if end < len(prompt) {
			r, _ := utf8.DecodeRuneInString(prompt[end:])
			if referenceWord(r) {
				continue
			}
		}
		label := strings.TrimRight(prompt[start:end], ".")
		if label == "@" {
			continue
		}
		if seen[label] {
			continue
		}
		seen[label] = true
		if len(refs) >= 64 {
			return nil, errors.New("reference at most 64 changes in one request")
		}
		n, ok := s.proposalIndex[label]
		if !ok {
			return nil, fmt.Errorf("unknown change reference %s; use a label shown in this conversation", label)
		}
		record := s.proposals[n]
		ref := Reference{Ref: label, Status: record.status, Before: record.before, After: record.after, Available: record.available}
		if h, ok := active[label]; ok {
			ref.Status = h.Decision
			if ref.Status == "" {
				ref.Status = "pending"
			}
			ref.Before, ref.After = h.Before, h.After
			ref.Available = true
			if h.Decision == "" {
				ref.start, ref.end, ref.positioned = h.Start, h.End, true
			}
		}
		// Archived labels are informational. Text equality cannot recover identity.
		if !ref.Available && ref.Status != "superseded" && ref.Status != "withdrawn" {
			return nil, fmt.Errorf("details for %s are no longer available; refer to a current change", label)
		}
		bytes += len(ref.Before) + len(ref.After)
		if bytes > maxRequestedReferenceBytes {
			return nil, errors.New("referenced changes are too large for one request; reference fewer changes")
		}
		refs = append(refs, ref)
	}
	return refs, nil
}

func referencesForRange(refs []Reference, source string, section Section) []Reference {
	result := make([]Reference, len(refs))
	for i, ref := range refs {
		if ref.Status != "superseded" && ref.Status != "undone" && ref.Available {
			if ref.positioned {
				ref.EditableHere = ref.start >= section.Start && ref.end <= section.End && (ref.start < section.End || section.End == len(source))
			}
		}
		result[i] = ref
	}
	return result
}

func validateReferencedChanges(refs []Reference, source string, section Section, hunks []Hunk) error {
	if len(refs) == 0 || len(hunks) == 0 {
		return nil
	}
	editable := false
	for _, ref := range referencesForRange(refs, source, section) {
		if ref.Status == "superseded" || ref.Status == "undone" {
			return fmt.Errorf("%s was %s; refer to a current change", ref.Ref, ref.Status)
		}
		editable = editable || ref.EditableHere
	}
	if !editable {
		return errors.New("the referenced suggestion is no longer editable in this draft; use a current change label")
	}
	return nil
}
