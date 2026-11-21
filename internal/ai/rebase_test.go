package ai

import (
	"errors"
	"testing"
)

func TestDiffSpanIsRuneSafe(t *testing.T) {
	for _, tc := range []struct {
		old, next string
		want      textChange
	}{
		{"abc", "abc", textChange{3, 3, 3}},
		{"abXc", "abYZc", textChange{2, 3, 4}},
		{"🙂a", "🙃a", textChange{0, 4, 4}},
		{"a🙂", "a🙃", textChange{1, 5, 5}},
		{"aaa", "aaaa", textChange{3, 3, 4}},
		{"", "new", textChange{0, 0, 3}},
	} {
		if got := diffSpan(tc.old, tc.next); got != tc.want {
			t.Fatalf("%q -> %q: %+v, want %+v", tc.old, tc.next, got, tc.want)
		}
	}
}

func rebaseFixture(t *testing.T) (*Manager, Session) {
	t.Helper()
	m := NewManager()
	t.Cleanup(m.Stop)
	s, err := m.Create("owner", "note", "note", "one two three four", Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	err = m.sessions[s.ID].publishSuggestions([]Hunk{
		{ID: "a", Start: 0, End: 3, Before: "one", After: "ONE"},
		{ID: "b", Start: 4, End: 7, Before: "two", After: "TWO"},
		{ID: "c", Start: 14, End: 18, Before: "four", After: "FOUR"},
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	s, _ = m.Metadata(s.ID, "owner")
	return m, s
}

func TestRebaseMovesUntouchedSuggestionsAndOutdatesTouchedOnes(t *testing.T) {
	m, s := rebaseFixture(t)
	// Another device rewrote "two three" and kept the rest.
	next, err := m.RebaseContext(s.ID, "owner", s.Version, "one 2 and 3 four")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Hunk{}
	for _, h := range next.Hunks {
		byID[h.ID] = h
	}
	if a := byID["a"]; a.Decision != "" || next.Draft[a.Start:a.End] != "one" {
		t.Fatal("suggestion before the change moved", a)
	}
	if b := byID["b"]; b.Decision != DecisionOutdated {
		t.Fatal("touched suggestion still pending", b)
	}
	if c := byID["c"]; c.Decision != "" || next.Draft[c.Start:c.End] != "four" {
		t.Fatal("suggestion after the change did not shift", c, next.Draft)
	}
	if next.Version != s.Version+1 || next.CanUndo {
		t.Fatal("rebase must bump the version and clear undo", next.Version, next.CanUndo)
	}
	if again, err := m.RebaseContext(s.ID, "owner", next.Version, next.Draft); err != nil || again.Version != next.Version {
		t.Fatal("same text must be a no-op", err)
	}
	if _, err := m.Review(s.ID, "owner", "accept", "b", next.Version); err == nil {
		t.Fatal("accepted an outdated suggestion")
	}
	dismissed, err := m.Review(s.ID, "owner", "reject", "b", next.Version)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := m.Review(s.ID, "owner", "accept_all", "", dismissed.Version)
	if err != nil || accepted.Draft != "ONE 2 and 3 FOUR" {
		t.Fatal("accept all after rebase", err, accepted.Draft)
	}
}

func TestRebaseRejectsBusyStaleAndUnsharedText(t *testing.T) {
	m, s := rebaseFixture(t)
	if _, err := m.RebaseContext(s.ID, "owner", s.Version+1, "x"); err == nil {
		t.Fatal("accepted a stale version")
	}
	m.mu.Lock()
	m.sessions[s.ID].busy = true
	m.mu.Unlock()
	if _, err := m.RebaseContext(s.ID, "owner", s.Version, "x"); !errors.Is(err, ErrBusy) {
		t.Fatal("rebased during a running job", err)
	}
	none, err := m.Create("owner", "note", "none", "", Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.RebaseContext(none.ID, "owner", 0, "unshared text"); err == nil {
		t.Fatal("accepted text for scope none")
	}
}
