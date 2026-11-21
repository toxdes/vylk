package ai

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestStableReferencesResolveOriginalProposalAndStatus(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "first\nsecond", Configuration{})
	_, _, _, err := m.Begin(s.ID, "owner", "edit both", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.Finish(s.ID, "owner", "{}", Reply{Edits: []Edit{{"first", "FIRST"}, {"second", "SECOND"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.Hunks[0].Ref != "@1" || s.Hunks[1].Ref != "@2" {
		t.Fatal(s.Hunks)
	}
	s, err = m.Review(s.ID, "owner", "accept", s.Hunks[0].ID, s.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, messages, _, err := m.Begin(s.ID, "owner", "make @2 shorter", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	var input providerContext
	_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
	if len(input.References) != 1 || input.References[0].After != "" || len(input.Blocks) != 1 || input.Blocks[0].ID != "@2" || input.Blocks[0].Text != "SECOND" || input.Originals[0].Text != "second" || input.References[0].Status != "pending" || !input.References[0].EditableHere {
		t.Fatal(input)
	}
	s, err = m.Finish(s.ID, "owner", "{}", Reply{Changes: []BlockChange{{ID: "@2", Before: "SECOND", After: "2"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.Hunks[0].Ref != "@2.1" {
		t.Fatal("reused reference", s.Hunks)
	}
	_, messages, _, err = m.Begin(s.ID, "owner", "compare @1, @2 and @2.1", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
	if len(input.References) != 3 || input.References[0].Status != "accepted" || input.References[0].After != "FIRST" || input.References[1].Status != "superseded" || input.References[1].After != "SECOND" || input.References[1].EditableHere || input.References[2].Ref != "@2.1" {
		t.Fatal(input)
	}
	s, _ = m.Finish(s.ID, "owner", "", Reply{}, errors.New("stop"))
	s, err = m.Review(s.ID, "owner", "reject", s.Hunks[0].ID, s.Version)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := m.sessions[s.ID].requestedReferences("@2.1")
	if err != nil || refs[0].Status != "rejected" {
		t.Fatal(refs, err)
	}
}

func TestReferenceParsingAndBoundedArchive(t *testing.T) {
	s := &Session{}
	for i := 0; i < 4; i++ {
		if err := s.publishSuggestions([]Hunk{{ID: ID(), Before: strings.Repeat("x", 200<<10), After: "next"}}); err != nil {
			t.Fatal(err)
		}
		s.Hunks[0].Decision = "accepted"
	}
	if s.proposalBytes > maxProposalHistoryBytes {
		t.Fatal("unbounded payload history", s.proposalBytes)
	}
	if _, err := s.requestedReferences("@1"); err == nil {
		t.Fatal("guessed evicted proposal")
	}
	for _, prompt := range []string{"@0", "@01", "@999", "@99999999999999999999999"} {
		if _, err := s.requestedReferences(prompt); err == nil {
			t.Fatal("accepted unknown reference", prompt)
		}
	}
	refs, err := s.requestedReferences("me@123.example é@4 @4word @team")
	if err != nil || len(refs) != 0 {
		t.Fatal("mistook other text for references", refs, err)
	}
	parsing := &Session{}
	for i := 0; i < 4; i++ {
		if err := parsing.publishSuggestions([]Hunk{{ID: ID(), Before: "old", After: "new"}}); err != nil {
			t.Fatal(err)
		}
	}
	refs, err = parsing.requestedReferences("(@4), @4 and `@3`.")
	if err != nil || len(refs) != 2 || refs[0].Ref != "@4" || refs[1].Ref != "@3" {
		t.Fatal(refs, err)
	}
}

func TestReferencedJobIncludesOnlyEditableRange(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	source := "first\n\n" + strings.Repeat("A paragraph to keep.\n\n", 400)
	s, _ := m.Create("owner", "note", "note", source, Configuration{})
	m.mu.Lock()
	err := m.sessions[s.ID].publishSuggestions([]Hunk{{ID: ID(), Start: 0, End: 5, Before: "first", After: "FIRST"}})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	p, err := m.PlanTurn(s.ID, "owner", "make @1 shorter", 0)
	if err != nil {
		t.Fatal(err)
	}
	if p.Sections != 1 {
		t.Fatal("reference revision dispatched unrelated ranges")
	}
	for i := range p.ranges {
		messages := p.messages(i)
		var input struct {
			References []Reference `json:"references"`
		}
		_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
		if len(input.References) != 1 || input.References[0].EditableHere != (i == 0) {
			t.Fatal("reference escaped assigned range", i, input)
		}
	}
	if _, err := m.PlanTurn(s.ID, "owner", "edit @999", 0); err == nil {
		t.Fatal("unknown reference dispatched")
	}
}

func TestSupersededReferencesCannotProduceEdits(t *testing.T) {
	refs := []Reference{{Ref: "@2", Status: "superseded", Before: "old", After: "suggested", Available: true}}
	if err := validateReferencedChanges(refs, "old", Section{0, 3}, []Hunk{{Start: 0, End: 3, Before: "old", After: "new"}}); err == nil {
		t.Fatal("superseded label produced edits")
	}
	if err := validateReferencedChanges(refs, "old", Section{0, 3}, nil); err != nil {
		t.Fatal("blocked answer about an old proposal", err)
	}
}

func TestArchivedReferencesNeverRecoverIdentityFromText(t *testing.T) {
	for _, tc := range []struct {
		source string
		want   bool
	}{
		{"before TARGET after", false},
		{"TARGET\n\nTARGET", false},
	} {
		s := &Session{Draft: tc.source, Hunks: []Hunk{}, proposals: []proposalRecord{{status: "rejected", before: "TARGET", after: "new", available: true, root: 1}}, proposalIndex: map[string]int{"@1": 0}, nextProposal: 1}
		refs, err := s.requestedReferences("revise @1")
		if err != nil {
			t.Fatal(err)
		}
		if got := referencesForRange(refs, s.Draft, Section{0, len(s.Draft)})[0].EditableHere; got != tc.want {
			t.Fatal("ambiguous archived reference", got)
		}
	}
}
