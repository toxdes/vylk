package ai

import (
	"fmt"
	"strings"
	"testing"
)

func TestRevisionLabelsKeepRootAcrossSplitsAndLaterEdits(t *testing.T) {
	s := &Session{}
	hunks := []Hunk{}
	for i := 1; i <= 30; i++ {
		before := fmt.Sprintf("first %d\nmiddle %d\nlast %d\n\n", i, i, i)
		start := len(s.Draft)
		s.Draft += before
		hunks = append(hunks, Hunk{ID: ID(), Start: start, End: len(s.Draft), Before: before, After: strings.Replace(before, "first", "original suggestion", 1)})
	}
	if err := s.publishSuggestions(hunks); err != nil {
		t.Fatal(err)
	}
	revise := func(label, after string) {
		t.Helper()
		refs, err := s.requestedReferences(label)
		if err != nil {
			t.Fatal(err)
		}
		local, revised, err := referencedReplyHunks(s.Draft, "note", nil, refs, Section{0, len(s.Draft)}, Reply{Changes: []BlockChange{{ID: label, Before: refs[0].After, After: after}}})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.publishScopedSuggestions(local, revised); err != nil {
			t.Fatal(err)
		}
	}
	revise("@5", "better first 5\nmiddle 5\nbetter last 5\n\n")
	if len(s.Hunks) != 31 || s.Hunks[4].Ref != "@5.1" || s.Hunks[5].Ref != "@5.2" || s.Hunks[6].Ref != "@6" {
		t.Fatal(s.Hunks)
	}
	revise("@5.1", "best first 5\n")
	if s.Hunks[4].Ref != "@5.3" || s.Hunks[5].Ref != "@5.2" {
		t.Fatal(s.Hunks)
	}
	refs, err := s.requestedReferences("compare @5, @5.1, @5.2 and @5.3.")
	if err != nil || len(refs) != 4 || refs[0].Status != "superseded" || refs[1].Status != "superseded" || refs[2].Status != "pending" || refs[3].Status != "pending" {
		t.Fatal(refs, err)
	}
	// Withdrawing one split diff preserves its sibling and consumes no new tag.
	revise("@5.3", s.Hunks[4].Before)
	refs, err = s.requestedReferences("@5.3")
	if err != nil || refs[0].Status != "withdrawn" || s.Hunks[4].Ref != "@5.2" {
		t.Fatal(refs, s.Hunks, err)
	}
	if next := s.allocateProposal(0); next != "@31" {
		t.Fatal("revisions consumed root numbers", next)
	}
	for _, invalid := range []string{"@5.0", "@5.01", "@5.1.2", "@5..1", "@05.1", "@5.9999"} {
		if _, err := s.requestedReferences(invalid); err == nil {
			t.Fatal("accepted invalid or unknown label", invalid)
		}
	}
	refs, err = s.requestedReferences("(@5.2), @5.2... mail@5.1 and @5.2word")
	if err != nil || len(refs) != 1 || refs[0].Ref != "@5.2" {
		t.Fatal(refs, err)
	}
}

func TestDottedRevisionAcceptanceAndUndoKeepExactHistory(t *testing.T) {
	m, s, _ := pendingReferenceFixture(t)
	m.mu.Lock()
	state := m.sessions[s.ID]
	h := state.Hunks[2]
	h.Ref, h.parentRef, h.After = "", "@3", "I like bezos daddy."
	err := state.publishScopedSuggestions([]Hunk{h}, []proposalRevision{{ref: "@3"}})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	s, _ = m.Metadata(s.ID, "owner")
	s, err = m.Review(s.ID, "owner", "accept", h.ID, s.Version)
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.Review(s.ID, "owner", "undo", "", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := m.sessions[s.ID].requestedReferences("@3 and @3.1")
	if err != nil || refs[0].Status != "superseded" || refs[1].Status != "undone" {
		t.Fatal(refs, err)
	}
}
