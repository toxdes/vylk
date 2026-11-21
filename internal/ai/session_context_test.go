package ai

import (
	"strings"
	"testing"
)

func TestContextChangeKeepsConversationAndFencesOldEdits(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "none", "", Configuration{})
	_, _, _, err := m.Begin(s.ID, "owner", "hello", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.Finish(s.ID, "owner", "", Reply{Answer: "Remember this conversation."}, nil)
	if err != nil {
		t.Fatal(err)
	}
	base := s.Version
	s, err = m.SetContext(s.ID, "owner", base, "selection", "first")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := m.SetContext(s.ID, "owner", base, "selection", "first")
	if err != nil || retry.Version != s.Version {
		t.Fatalf("non-idempotent context retry: %+v %v", retry, err)
	}
	if _, err := m.SetContext(s.ID, "other", s.Version, "note", "other"); err == nil {
		t.Fatal("accepted other owner")
	}
	if _, err := m.SetContext(s.ID, "owner", base, "note", "other"); err == nil {
		t.Fatal("accepted stale context")
	}
	_, messages, _, err := m.Begin(s.ID, "owner", "fix this", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || !strings.Contains(messages[2].Content, "Remember this conversation.") {
		t.Fatalf("lost history: %+v", messages)
	}
	if _, err := m.SetContext(s.ID, "owner", s.Version, "none", ""); err != ErrBusy {
		t.Fatal("changed running context", err)
	}
	s, err = m.Finish(s.ID, "owner", "", Reply{Answer: ReviewChangesAnswer, Edits: []Edit{{"first", "FIRST"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetContext(s.ID, "owner", s.Version, "none", ""); err == nil {
		t.Fatal("discarded pending edits")
	}
	s, err = m.Review(s.ID, "owner", "accept_all", "", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.SetContext(s.ID, "owner", s.Version, "selection", "FIRST")
	if err != nil || s.Changed || s.CanUndo || len(s.Hunks) != 0 {
		t.Fatalf("old snapshot state leaked: %+v %v", s, err)
	}
}
