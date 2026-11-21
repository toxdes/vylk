package ai

import (
	"errors"
	"unicode/utf8"
)

// Outdated suggestions stay visible for dismissal but can never be accepted.
const DecisionOutdated = "outdated"

// textChange is the one span where two texts differ: old[Start:OldEnd]
// became new[Start:NewEnd]. Several separate edits merge into one span, so a
// suggestion between them is conservatively outdated.
type textChange struct{ Start, OldEnd, NewEnd int }

func diffSpan(old, next string) textChange {
	prefix := 0
	for prefix < len(old) && prefix < len(next) && old[prefix] == next[prefix] {
		prefix++
	}
	// old[:prefix] equals next[:prefix], so one rune start serves both.
	for prefix > 0 && (prefix < len(old) && !utf8.RuneStart(old[prefix]) || prefix < len(next) && !utf8.RuneStart(next[prefix])) {
		prefix--
	}
	suffix := 0
	for suffix < len(old)-prefix && suffix < len(next)-prefix && old[len(old)-1-suffix] == next[len(next)-1-suffix] {
		suffix++
	}
	for suffix > 0 && (!utf8.RuneStart(old[len(old)-suffix]) || !utf8.RuneStart(next[len(next)-suffix])) {
		suffix--
	}
	return textChange{Start: prefix, OldEnd: len(old) - suffix, NewEnd: len(next) - suffix}
}

// RebaseContext moves suggestions onto shared text changed outside AI, such as
// an edit synced from another device. Pending suggestions the change touches
// become outdated; the rest shift with it. The conversation is kept. Undo is
// cleared because its offsets refer to the old text.
func (m *Manager) RebaseContext(id, owner string, version int, source string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Session{}, err
	}
	if !ValidText(source, MaxSnapshot) || (s.Scope == "none" && source != "") {
		return Session{}, errors.New("invalid shared text or context exceeds 1 MiB")
	}
	if s.busy || s.planning {
		return Session{}, ErrBusy
	}
	if s.Version != version {
		return Session{}, errors.New("AI draft changed; refresh the review")
	}
	if source == s.Draft {
		return s.view(), nil
	}
	change := diffSpan(s.Draft, source)
	delta := change.NewEnd - change.OldEnd
	for i := range s.Hunks {
		h := &s.Hunks[i]
		switch {
		case h.Decision == DecisionOutdated:
		case h.End <= change.Start:
			// Entirely before the change, including insertions at its start.
		case h.Start >= change.OldEnd:
			h.Start += delta
			h.End += delta
		case h.Decision == "":
			h.Decision = DecisionOutdated
			h.Start, h.End = 0, 0
		default:
			// Reviewed hunks are history; keep their offsets inside the text.
			h.Start, h.End = change.Start, change.Start
		}
	}
	if s.Draft == s.original {
		s.original = source
	}
	s.Draft = source
	s.undo = nil
	s.undoBytes = 0
	s.plan = nil
	s.planEpoch++
	s.Version++
	return s.view(), nil
}
