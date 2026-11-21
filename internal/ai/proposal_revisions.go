package ai

import (
	"errors"
	"sort"
	"strings"
)

type proposalRevision struct {
	ref       string
	withdrawn bool
}

func referencedSections(refs []Reference, source string, ranges []Section) []Section {
	if len(refs) == 0 {
		return ranges
	}
	selected := []Section{}
	for _, ref := range referencesForRange(refs, source, Section{0, len(source)}) {
		if !ref.EditableHere {
			continue
		}
		start, end := ref.start, ref.end

		lo, hi := -1, -1
		for i, r := range ranges {
			if start >= r.Start && (start < r.End || start == len(source) && r.End == len(source)) {
				lo = i
			}
			if end > r.Start && end <= r.End {
				hi = i
			}
		}
		if start == end {
			hi = lo
		}
		if lo >= 0 && hi >= lo {
			selected = append(selected, Section{ranges[lo].Start, ranges[hi].End})
		}
	}
	// Keep a referenced span whole even when accepted edits moved it across a
	// planning boundary. Preflight still checks the resulting context budget.
	sort.Slice(selected, func(i, j int) bool { return selected[i].Start < selected[j].Start })
	merged := selected[:0]
	for _, r := range selected {
		if len(merged) > 0 && r.Start < merged[len(merged)-1].End {
			last := &merged[len(merged)-1]
			last.End = max(last.End, r.End)
		} else {
			merged = append(merged, r)
		}
	}
	// Historical questions need one reply, not a call for every note section.
	if len(merged) == 0 {
		return ranges[:1]
	}
	return merged
}

func hunksOverlap(a, b Hunk) bool { return a.Start == b.Start || a.Start < b.End && b.Start < a.End }

// @IDs revise an explicitly referenced pending proposal, not the accepted note.
// Returning its original Before text withdraws it, even when no new diff exists.
func referencedReplyHunks(source, scope string, blocks []Block, refs []Reference, r Section, reply Reply) ([]Hunk, []proposalRevision, error) {
	if len(reply.Changes) > MaxBlockChanges {
		return nil, nil, errors.New("model returned too many changes")
	}
	if len(refs) == 0 || reply.Changes == nil {
		hunks, err := replyHunks(source[r.Start:r.End], scope, blocks, reply)
		revised := []proposalRevision{}
		if err == nil {
			for _, ref := range refs {
				if ref.positioned && ref.Status == "pending" {
					for _, h := range hunks {
						h.Start += r.Start
						h.End += r.Start
						if hunksOverlap(h, Hunk{Start: ref.start, End: ref.end}) {
							revised = append(revised, proposalRevision{ref: ref.Ref})
							break
						}
					}
				}
			}
		}
		return hunks, revised, err
	}
	available := referencesForRange(refs, source, r)
	byRef := make(map[string]Reference, len(available))
	pending := false
	for _, ref := range available {
		byRef[ref.Ref] = ref
		pending = pending || ref.Status == "pending"
	}
	regular := []BlockChange{}
	revisions := map[string][]BlockChange{}
	for _, change := range reply.Changes {
		if strings.HasPrefix(change.ID, "@") {
			revisions[change.ID] = append(revisions[change.ID], change)
		} else {
			regular = append(regular, change)
		}
	}
	if pending && len(regular) > 0 {
		return nil, nil, errors.New("model edited the note instead of revising the referenced suggestion; retry the request")
	}
	hunks, err := blockHunks(source[r.Start:r.End], scope, blocks, regular)
	if err != nil {
		return nil, nil, err
	}
	revised := []proposalRevision{}
	budget := maxReplacementCells
	for id, edits := range revisions {
		ref, ok := byRef[id]
		if !ok || !ref.positioned || ref.Status != "pending" || !ref.EditableHere {
			return nil, nil, errors.New("model revised a suggestion that is not pending in this request")
		}
		if ref.start < r.Start || ref.end > r.End || source[ref.start:ref.end] != ref.Before {
			return nil, nil, errors.New("the referenced suggestion changed; reopen AI")
		}
		updated, err := applyCompactChanges(ref.After, edits)
		if err != nil {
			return nil, nil, err
		}
		if updated != ref.Before {
			original := ref.Before
			if original == "" {
				original = ref.After
			}
			updated = preserveBlockWhitespace(original, updated)
		}
		if updated == ref.After {
			continue
		}
		revised = append(revised, proposalRevision{ref: ref.Ref, withdrawn: updated == ref.Before})
		if updated == ref.Before {
			continue
		}
		local, err := blockReplacementHunks(ref.Before, updated, scope, &budget)
		if err != nil {
			return nil, nil, err
		}
		for _, h := range local {
			h.parentRef = ref.Ref
			h.Start += ref.start - r.Start
			h.End += ref.start - r.Start
			hunks = append(hunks, h)
		}
	}
	return hunks, revised, nil
}

// Publish only the named revisions. Unrelated pending labels and decisions stay
// intact; no new draft text is applied until the user accepts a proposal.
func (s *Session) publishScopedSuggestions(hunks []Hunk, revised []proposalRevision) error {
	if len(hunks) == 0 && len(revised) == 0 {
		return nil
	}
	targets := map[string]bool{}
	for _, revision := range revised {
		targets[revision.ref] = true
	}
	kept, removed := []Hunk{}, []Hunk{}
	for _, h := range s.Hunks {
		if targets[h.Ref] || h.Decision != "" {
			removed = append(removed, h)
			delete(targets, h.Ref)
		} else {
			kept = append(kept, h)
		}
	}
	if len(targets) > 0 {
		return errors.New("the referenced suggestion changed; reopen AI")
	}
	if len(s.proposals)+len(hunks) > maxProposalReferences {
		return errors.New("change reference limit reached; start a new AI conversation")
	}
	all := append(kept, hunks...)
	sort.Slice(all, func(i, j int) bool { return all[i].Start < all[j].Start })
	size, bytes := len(s.Draft), 0
	for i, h := range all {
		if h.parentRef != "" {
			if _, ok := s.proposalIndex[h.parentRef]; !ok {
				return errors.New("the referenced suggestion changed; reopen AI")
			}
		}
		if i > 0 && hunksOverlap(all[i-1], h) {
			return errors.New("revised suggestion overlaps another pending change; review those changes first")
		}
		size += len(h.After) - len(h.Before)
		bytes += len(h.Before) + len(h.After)
	}
	if len(all) > 512 || bytes > 2*MaxSnapshot || size > MaxSnapshot {
		return errors.New("combined suggestions exceed the review limit")
	}
	s.archiveHunks(removed)
	for _, revision := range revised {
		if revision.withdrawn {
			n := s.proposalIndex[revision.ref]
			s.proposals[n].status = "withdrawn"
		}
	}
	for i := range all {
		if all[i].Ref == "" {
			root := 0
			if all[i].parentRef != "" {
				root = s.proposals[s.proposalIndex[all[i].parentRef]].root
			}
			all[i].Ref = s.allocateProposal(root)
			all[i].parentRef = ""
		}
	}
	s.Hunks = all
	return nil
}
