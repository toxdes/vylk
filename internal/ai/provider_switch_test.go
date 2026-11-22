package ai

import "testing"

func TestProviderSwitchPreservesPendingReviewAndInvalidatesPlan(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "first", Configuration{ID: "old"})
	if _, _, _, err := m.Begin(s.ID, "owner", "fix", s.Version); err != nil {
		t.Fatal(err)
	}
	s, err := m.Finish(s.ID, "owner", "", Reply{Answer: "Review", Edits: []Edit{{"first", "FIRST"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := m.PlanTurn(s.ID, "owner", "revise @1", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	next, err := m.SetConfiguration(s.ID, "owner", s.Version, Configuration{ID: "new", ThinkingControllable: true})
	if err != nil {
		t.Fatal(err)
	}
	if next.Draft != s.Draft || len(next.Hunks) != 1 || next.Hunks[0] != s.Hunks[0] || next.ConfigurationID != "new" || !next.ThinkingControllable {
		t.Fatalf("review lost on switch: %+v", next)
	}
	if _, err := m.StartJob(s.ID, "owner", plan.ID, plan.Version, nil); err == nil {
		t.Fatal("started old provider plan")
	}
	if _, err := m.SetConfiguration(s.ID, "owner", s.Version, Configuration{ID: "old"}); err == nil {
		t.Fatal("accepted stale switch")
	}
	if _, err := m.SetConfiguration(s.ID, "other", next.Version, Configuration{ID: "old"}); err == nil {
		t.Fatal("accepted other owner")
	}
	c, _, _, err := m.Begin(s.ID, "owner", "revise @1", next.Version)
	if err != nil || c.ID != "new" {
		t.Fatalf("next turn uses %q: %v", c.ID, err)
	}
	if _, err := m.SetConfiguration(s.ID, "owner", next.Version, Configuration{ID: "old"}); err != ErrBusy {
		t.Fatalf("switched busy session: %v", err)
	}
}
