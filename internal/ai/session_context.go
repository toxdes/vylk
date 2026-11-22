package ai

import "errors"

// A new sharing context keeps conversation and historical labels, but cannot
// inherit pending edits or undo offsets from a different source snapshot.
func (m *Manager) SetContext(id, owner string, version int, scope, source string) (Session, error) {
	if !ValidText(source, MaxSnapshot) || (scope != "none" && scope != "selection" && scope != "note") || (scope == "none" && source != "") {
		return Session{}, errors.New("invalid sharing scope or context exceeds 1 MiB")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Session{}, err
	}
	if s.busy || s.planning {
		return Session{}, ErrBusy
	}
	for _, hunk := range s.Hunks {
		if hunk.Decision == "" {
			return Session{}, errors.New("review pending changes before changing shared text")
		}
	}
	if s.Version != version {
		if s.contextVersion > 0 && s.Version == s.contextVersion && version+1 == s.contextVersion && s.Scope == scope && s.Draft == source && s.original == source {
			return s.view(), nil
		}
		return Session{}, errors.New("AI draft changed; refresh the review")
	}
	s.archiveSuggestions()
	s.Scope, s.Draft, s.original = scope, source, source
	s.Hunks = []Hunk{}
	s.undo = nil
	s.undoBytes = 0
	s.plan = nil
	s.planEpoch++
	s.Version++
	s.contextVersion = s.Version
	return s.view(), nil
}
