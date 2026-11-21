package ai

import (
	"context"
	"strings"
	"testing"
)

func pendingReferenceFixture(t *testing.T) (*Manager, Session, string) {
	t.Helper()
	m := NewManager()
	t.Cleanup(m.Stop)
	source := "first task\n\nother task\n\n" + strings.Repeat("A paragraph to keep.\n\n", 400) + "I likes bezos daddy.\n\nLast task"
	s, err := m.Create("owner", "note", "note", source, Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	target := strings.Index(source, "I likes")
	m.mu.Lock()
	err = m.sessions[s.ID].publishSuggestions([]Hunk{
		{ID: ID(), Start: 0, End: 10, Before: "first task", After: "first actionable task"},
		{ID: ID(), Start: 12, End: 22, Before: "other task", After: "other actionable task"},
		{ID: ID(), Start: target, End: target + len("I likes bezos daddy."), Before: "I likes bezos daddy.", After: "I like Amazon."},
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	s, _ = m.Metadata(s.ID, "owner")
	return m, s, source
}

func TestReferencedRevisionPreservesOtherProposalsAndNeverAppliesDraft(t *testing.T) {
	for _, withdraw := range []bool{false, true} {
		t.Run(map[bool]string{false: "revise", true: "withdraw"}[withdraw], func(t *testing.T) {
			m, s, source := pendingReferenceFixture(t)
			plan, err := m.PlanTurn(s.ID, "owner", "@3 keep bezos daddy", s.Version)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Sections != 1 || plan.ranges[0].Start == 0 {
				t.Fatal("unrelated context was dispatched", plan.ranges)
			}
			wanted := "I like bezos daddy."
			if withdraw {
				wanted = "I likes bezos daddy."
			}
			calls := 0
			_, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, func(_ context.Context, _ Configuration, _ []Message, _, _, _ string) (Reply, error) {
				calls++
				return Reply{Answer: "Updated that suggestion.", Changes: []BlockChange{{ID: "@3", Before: "I like Amazon.", After: wanted}}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if job := waitJob(t, m, s.ID); job.Status != "completed" {
				t.Fatal(job.Error)
			}
			current, err := m.Metadata(s.ID, "owner")
			if err != nil || current.Draft != source || current.Changed || calls != 1 {
				t.Fatal("revision applied note text or dispatched extra calls", err, calls)
			}
			if len(current.Hunks) < 2 || current.Hunks[0].ID != s.Hunks[0].ID || current.Hunks[1].ID != s.Hunks[1].ID {
				t.Fatal("unrelated proposals changed", current.Hunks)
			}
			refs, err := m.sessions[s.ID].requestedReferences("@3")
			if err != nil {
				t.Fatal(err)
			}
			if withdraw {
				if len(current.Hunks) != 2 || refs[0].Status != "withdrawn" {
					t.Fatal(current.Hunks, refs)
				}
			} else {
				if len(current.Hunks) != 3 || current.Hunks[2].Ref != "@3.1" || current.Hunks[2].After != wanted || refs[0].Status != "superseded" {
					t.Fatal(current.Hunks, refs)
				}
			}
		})
	}
}

func TestAnswerOnlyReferenceFollowupDoesNotWithdrawSuggestions(t *testing.T) {
	m, s, source := pendingReferenceFixture(t)
	plan, err := m.PlanTurn(s.ID, "owner", "what does @3 change?", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, func(_ context.Context, _ Configuration, _ []Message, _, _, _ string) (Reply, error) {
		return Reply{Answer: "It changes that phrase.", Changes: []BlockChange{}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if job := waitJob(t, m, s.ID); job.Status != "completed" {
		t.Fatal(job.Error)
	}
	current, _ := m.Metadata(s.ID, "owner")
	if current.Draft != source || len(current.Hunks) != 3 || current.Hunks[2].Ref != "@3" {
		t.Fatal("question withdrew a suggestion")
	}
}

func TestCompactRevisionAnchorsUsePendingAfterAndPreserveOtherSuggestions(t *testing.T) {
	m, s, source := pendingReferenceFixture(t)
	plan, err := m.PlanTurn(s.ID, "owner", "revise @3", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
		return Reply{Answer: "Updated the suggestion.", Changes: []BlockChange{
			{ID: "@3", Before: "Amazon", After: "bezos daddy"},
			{ID: "@3", Before: "I like", After: "I really like"},
		}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if job := waitJob(t, m, s.ID); job.Status != "completed" {
		t.Fatal(job.Error)
	}
	current, _ := m.Metadata(s.ID, "owner")
	if current.Draft != source || len(current.Hunks) != 3 || current.Hunks[2].After != "I really like bezos daddy." || current.Hunks[0].ID != s.Hunks[0].ID || current.Hunks[1].ID != s.Hunks[1].ID {
		t.Fatal(current.Hunks)
	}
}

func TestInvalidReferenceRevisionLeavesAllPendingProposalsIntact(t *testing.T) {
	for _, kind := range []string{"unknown", "duplicate", "block edit"} {
		t.Run(kind, func(t *testing.T) {
			m, s, source := pendingReferenceFixture(t)
			plan, err := m.PlanTurn(s.ID, "owner", "revise @3", s.Version)
			if err != nil {
				t.Fatal(err)
			}
			changes := []BlockChange{{ID: "@999", Before: "unknown", After: "bad"}}
			if kind == "duplicate" {
				changes = []BlockChange{{ID: "@3", Before: "I like Amazon.", After: "new"}, {ID: "@3", Before: "I like Amazon.", After: "another"}}
			}
			if kind == "block edit" {
				changes = []BlockChange{{ID: plan.blocks[0][0].ID, Before: plan.blocks[0][0].Text, After: "unrelated edit"}}
			}
			_, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, func(_ context.Context, _ Configuration, _ []Message, _, _, _ string) (Reply, error) {
				return Reply{Answer: "Changed", Changes: changes}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if job := waitJob(t, m, s.ID); job.Status != "failed" {
				t.Fatal("invalid revision accepted", job)
			}
			current, _ := m.Metadata(s.ID, "owner")
			if current.Draft != source || len(current.Hunks) != 3 || current.Hunks[2].ID != s.Hunks[2].ID {
				t.Fatal("failed revision mutated review")
			}
		})
	}
}

func TestReferenceRoutingKeepsCrossBoundarySpanTogether(t *testing.T) {
	source := "0123456789abcdefghij"
	refs := []Reference{{Ref: "@3", Status: "pending", Before: source[8:13], After: "next", Available: true, start: 8, end: 13, positioned: true}}
	got := referencedSections(refs, source, []Section{{0, 10}, {10, 20}})
	if len(got) != 1 || got[0] != (Section{0, 20}) {
		t.Fatal("referenced span split", got)
	}
}
