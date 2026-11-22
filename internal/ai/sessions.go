package ai

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var ErrSession = errors.New("AI session expired or unavailable; reopen AI")
var ErrBusy = errors.New("AI request is already in progress")

type Hunk struct {
	ID        string `json:"id"`
	Ref       string `json:"ref"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Before    string `json:"before"`
	After     string `json:"after"`
	Decision  string `json:"decision"`
	parentRef string
}
type inverse struct {
	start         int
	before, after string
	ref           string
}
type Session struct {
	ConfigurationID            string `json:"configuration_id"`
	CurrentJob                 *Job   `json:"job,omitempty"`
	ThinkingControllable       bool   `json:"thinking_controllable"`
	ID                         string `json:"id"`
	NoteID                     string `json:"note_id"`
	Scope                      string `json:"scope"`
	Draft                      string `json:"draft"`
	Hunks                      []Hunk `json:"hunks"`
	Answer                     string `json:"answer"`
	Version                    int    `json:"version"`
	CanUndo                    bool   `json:"can_undo"`
	Changed                    bool   `json:"changed"`
	owner, original            string
	proposals                  []proposalRecord
	proposalIndex              map[string]int
	nextProposal               int
	proposalPayloads           []int
	payloadHead, proposalBytes int
	history                    []Message
	pendingPrompt              string
	pendingBlocks              []Block
	turns                      int
	busy                       bool
	planEpoch                  uint64
	planning                   bool
	undo                       [][]inverse
	undoBytes                  int
	ctx                        context.Context
	cancel                     context.CancelFunc
	timer                      *time.Timer
	Configuration              Configuration `json:"-"`
	plan                       *Plan
	contextVersion             int
	job                        *jobState
}

// Switching providers preserves the review while invalidating its frozen plan.
func (m *Manager) SetConfiguration(id, owner string, version int, c Configuration) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Session{}, err
	}
	if s.busy || s.planning {
		return Session{}, ErrBusy
	}
	if s.Version != version {
		return Session{}, errors.New("AI draft changed; refresh the review")
	}
	if s.Configuration.ID != c.ID || s.Configuration.Revision != c.Revision {
		s.Configuration = c
		s.ThinkingControllable = c.ThinkingControllable
		s.plan = nil
		s.planEpoch++
		s.Version++
	}
	return s.view(), nil
}

type Manager struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	Provider  *Provider
	Context   context.Context
	cancel    context.CancelFunc
	checks    int
	slots     chan struct{}
	planSlots chan struct{}
	testKey   [32]byte
}

func NewManager(concurrency ...int) *Manager {
	limit := 1
	if len(concurrency) > 0 && concurrency[0] > 0 {
		limit = min(concurrency[0], 8)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{planSlots: make(chan struct{}, 1), slots: make(chan struct{}, limit), sessions: make(map[string]*Session), Provider: NewProvider(limit), Context: ctx, cancel: cancel}
	if _, err := rand.Read(m.testKey[:]); err != nil {
		panic(err)
	}
	return m
}
func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func Owner(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (m *Manager) Create(owner, noteID, scope, source string, c Configuration) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Context.Err() != nil {
		return Session{}, ErrSession
	}
	if len(m.sessions) >= 4 {
		return Session{}, errors.New("four AI sessions are already open; close another session first")
	}
	if !ValidText(source, MaxSnapshot) || (scope != "none" && scope != "selection" && scope != "note") || (scope == "none" && source != "") {
		return Session{}, errors.New("invalid sharing scope or context exceeds 1 MiB")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{ThinkingControllable: c.ThinkingControllable, ID: ID(), NoteID: noteID, Scope: scope, Draft: source, original: source, owner: owner, ctx: ctx, cancel: cancel, Configuration: c, Hunks: []Hunk{}}
	m.sessions[s.ID] = s
	s.timer = time.AfterFunc(30*time.Minute, func() { m.Close(s.ID, owner) })
	return s.view(), nil
}
func (s *Session) view() Session {
	view := Session{ThinkingControllable: s.ThinkingControllable, ID: s.ID, NoteID: s.NoteID, Scope: s.Scope, Draft: s.Draft, Hunks: append([]Hunk{}, s.Hunks...), Answer: s.Answer, Version: s.Version, CanUndo: len(s.undo) > 0, Changed: s.Draft != s.original}
	if s.job != nil {
		j := s.job.Job
		view.CurrentJob = &j
	}
	view.ConfigurationID = s.Configuration.ID
	return view
}
func (m *Manager) find(id, owner string) (*Session, error) {
	s := m.sessions[id]
	if s == nil || s.owner != owner {
		return nil, ErrSession
	}
	s.timer.Reset(30 * time.Minute)
	return s, nil
}
func (m *Manager) Metadata(id, owner string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Session{}, err
	}
	return s.view(), nil
}
func (m *Manager) Close(id, owner string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[id]; s != nil && s.owner == owner {
		m.remove(s)
	}
}
func (m *Manager) remove(s *Session) { delete(m.sessions, s.ID); s.timer.Stop(); s.cancel() }
func (m *Manager) CloseOwner(owner string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.owner == owner {
			m.remove(s)
		}
	}
}
func (m *Manager) CloseConfiguration(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.Configuration.ID == id {
			m.remove(s)
		}
	}
}
func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cancel()
	for _, s := range m.sessions {
		m.remove(s)
	}
	m.Provider.Close()
}
func (m *Manager) CheckSlot() (func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Context.Err() != nil {
		return nil, ErrSession
	}
	if m.inFlight() >= 4 {
		return nil, ErrBusy
	}
	select {
	case m.slots <- struct{}{}:
	default:
		return nil, ErrBusy
	}
	m.checks++
	var once sync.Once
	return func() { once.Do(func() { <-m.slots; m.mu.Lock(); m.checks--; m.mu.Unlock() }) }, nil
}
func (m *Manager) inFlight() int {
	n := m.checks
	for _, s := range m.sessions {
		if s.busy || s.planning {
			n++
		}
	}
	return n
}

func (m *Manager) Begin(id, owner, prompt string, version int, thinking ...bool) (Configuration, []Message, context.Context, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Configuration{}, nil, nil, err
	}
	if s.busy || s.planning {
		return Configuration{}, nil, nil, ErrBusy
	}
	if m.inFlight() >= 4 {
		return Configuration{}, nil, nil, ErrBusy
	}
	if version != s.Version {
		return Configuration{}, nil, nil, errors.New("AI draft changed; refresh the review")
	}
	if !ValidText(prompt, 16<<10) || strings.TrimSpace(prompt) == "" {
		return Configuration{}, nil, nil, errors.New("enter a prompt of at most 16 KiB")
	}
	if s.turns >= 20 {
		return Configuration{}, nil, nil, errors.New("20-turn limit reached; start a new session")
	}
	useThinking := len(thinking) > 0 && thinking[0]
	if useThinking && !s.Configuration.ThinkingControllable {
		return Configuration{}, nil, nil, errors.New("thinking cannot be controlled for this model; reopen AI")
	}
	refs, err := s.requestedReferences(prompt)
	if err != nil {
		return Configuration{}, nil, nil, err
	}
	blocks, err := editableBlocks(s.Draft, 0, s.Version)
	if err != nil {
		return Configuration{}, nil, nil, err
	}
	contextData, _ := json.Marshal(providerInput(s.Scope, blocks, prompt, s.Hunks, referencesForRange(refs, s.Draft, Section{0, len(s.Draft)})))

	system := SystemPrompt
	if len(refs) > 0 {
		system += ReferencePrompt
	}
	messages := []Message{{"system", system}}
	messages = append(messages, s.history...)
	messages = append(messages, Message{"user", string(contextData)})
	size := 0
	for _, message := range messages {
		size += len(message.Content)
	}
	// Reserve room for the bounded reply before dispatching a billable request.
	if size+MaxContext > MaxHistory {
		return Configuration{}, nil, nil, errors.New("conversation limit reached; start a new session")
	}
	s.plan = nil
	s.pendingPrompt = prompt
	s.pendingBlocks = blocks
	s.turns++
	s.busy = true
	c := s.Configuration
	if c.ThinkingControllable {
		c.Thinking = &useThinking
	}
	return c, messages, s.ctx, nil
}

func ValidateEdits(source, scope string, edits []Edit) ([]Hunk, error) {
	if len(edits) > 64 {
		return nil, errors.New("model returned more than 64 edits")
	}
	if scope == "none" && len(edits) > 0 {
		return nil, errors.New("model proposed edits without sharing permission")
	}
	hunks := make([]Hunk, 0, len(edits))
	size := len(source)
	for _, e := range edits {
		if !ValidText(e.Before, MaxContext) || !ValidText(e.After, MaxContext) || e.Before == e.After {
			return nil, errors.New("model returned an invalid edit")
		}
		start := 0
		if e.Before == "" {
			if source != "" || len(edits) != 1 {
				return nil, errors.New("empty edit anchor is only valid at an empty insertion point")
			}
		} else {
			start = strings.Index(source, e.Before)
			if start < 0 || strings.Contains(source[start+1:], e.Before) {
				return nil, errors.New("edit anchor is missing or ambiguous; ask for a more specific edit")
			}
		}
		hunks = append(hunks, Hunk{ID: ID(), Start: start, End: start + len(e.Before), Before: e.Before, After: e.After})
		size += len(e.After) - len(e.Before)
	}
	if size > MaxSnapshot {
		return nil, errors.New("proposed draft exceeds 1 MiB")
	}
	sort.Slice(hunks, func(i, j int) bool { return hunks[i].Start < hunks[j].Start })
	for i := 1; i < len(hunks); i++ {
		if hunks[i].Start < hunks[i-1].End || hunks[i].Start == hunks[i-1].Start {
			return nil, errors.New("model returned overlapping edits")
		}
	}
	return hunks, nil
}

func (m *Manager) Finish(id, owner, raw string, reply Reply, callErr error) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Session{}, err
	}
	if s.job != nil && s.job.Status == "running" {
		return Session{}, ErrBusy
	}
	s.busy = false
	prompt := s.pendingPrompt
	s.pendingPrompt = ""
	if callErr != nil {
		s.pendingBlocks = nil
		return s.view(), callErr
	}
	blocks := s.pendingBlocks
	s.pendingBlocks = nil
	refs, refErr := s.requestedReferences(prompt)
	if refErr != nil {
		return s.view(), refErr
	}
	hunks, revised, err := referencedReplyHunks(s.Draft, s.Scope, blocks, refs, Section{0, len(s.Draft)}, reply)
	if err != nil {
		return s.view(), err
	}
	if err := validateReferencedChanges(refs, s.Draft, Section{0, len(s.Draft)}, hunks); err != nil {
		return s.view(), err
	}
	if len(raw) > MaxContext {
		return s.view(), errors.New("model reply exceeds 256 KiB")
	}
	var publishErr error
	if len(refs) > 0 {
		publishErr = s.publishScopedSuggestions(hunks, revised)
	} else {
		publishErr = s.publishSuggestions(hunks)
	}
	if err := publishErr; err != nil {
		return s.view(), err
	}
	acknowledgement := ""
	if len(hunks) > 0 {
		acknowledgement = ReviewChangesAnswer
	} else if len(revised) > 0 {
		acknowledgement = RevisedSuggestionsAnswer
	}
	s.Answer = mergeAnswers([]string{reply.Answer}, acknowledgement)
	s.history = append(s.history, Message{"user", prompt}, Message{"assistant", s.Answer})
	s.Version++
	return s.view(), nil
}

// Review changes only the shared working draft. Note persistence belongs to the caller.
func (m *Manager) Review(id, owner, action, hunkID string, version int) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Session{}, err
	}
	if s.busy || s.planning {
		return Session{}, ErrBusy
	}
	if version != s.Version {
		return Session{}, errors.New("AI draft changed; refresh the review")
	}
	if action == "finalize" {
		for _, h := range s.Hunks {
			if h.Decision == "" {
				return Session{}, errors.New("review every hunk before accepting changes")
			}
		}
		if s.Draft == s.original {
			return Session{}, errors.New("no changes to accept")
		}
		return s.view(), nil
	}
	if action == "undo" {
		if len(s.undo) == 0 {
			return Session{}, errors.New("no accepted changes to undo")
		}
		s.archiveSuggestions()
		a := s.undo[len(s.undo)-1]
		s.undo = s.undo[:len(s.undo)-1]
		for i := len(a) - 1; i >= 0; i-- {
			v := a[i]
			s.Draft = s.Draft[:v.start] + v.before + s.Draft[v.start+len(v.after):]
			s.undoBytes -= len(v.before) + len(v.after)
			if n, ok := s.proposalIndex[v.ref]; ok {
				s.proposals[n].status = "undone"
			}
		}
		s.Hunks = []Hunk{}
		s.Version++
		return s.view(), nil
	}
	if action != "accept" && action != "reject" && action != "accept_all" {
		return Session{}, errors.New("invalid review action")
	}
	indexes := []int{}
	cost := 0
	nextSize := len(s.Draft)
	for i, h := range s.Hunks {
		// Outdated suggestions can only be dismissed.
		pending := h.Decision == "" || action == "reject" && h.Decision == DecisionOutdated
		if pending && (action == "accept_all" || h.ID == hunkID) {
			indexes = append(indexes, i)
			cost += len(h.Before) + len(h.After)
			nextSize += len(h.After) - len(h.Before)
		}
	}
	if len(indexes) == 0 {
		return Session{}, errors.New("suggestion is no longer pending")
	}
	if action != "reject" && nextSize > MaxSnapshot {
		return Session{}, errors.New("accepted draft would exceed 1 MiB; review a smaller edit or accept all")
	}
	if action != "reject" && (s.undoBytes+cost > 2*MaxSnapshot || len(s.undo) >= 128) {
		return Session{}, errors.New("undo storage limit reached; finish this draft before starting another session")
	}
	var inverses []inverse
	for n := len(indexes) - 1; n >= 0; n-- {
		i := indexes[n]
		h := &s.Hunks[i]
		if action == "reject" {
			h.Decision = "rejected"
			continue
		}
		start, end := h.Start, h.End
		inverses = append(inverses, inverse{start: start, before: h.Before, after: h.After, ref: h.Ref})
		s.Draft = s.Draft[:start] + h.After + s.Draft[end:]
		delta := len(h.After) - (end - start)
		h.End = start + len(h.After)
		h.Decision = "accepted"
		for j := range s.Hunks {
			if j != i && s.Hunks[j].Start >= end {
				s.Hunks[j].Start += delta
				s.Hunks[j].End += delta
			}
		}
	}
	if len(inverses) > 0 {
		s.undo = append(s.undo, inverses)
		s.undoBytes += cost
	}
	s.Version++
	return s.view(), nil
}

// Browser text offsets count UTF-16 code units, unlike Go's byte indexes.
func BrowserView(s Session) Session {
	type position struct {
		offset, index int
		end           bool
	}
	positions := make([]position, 0, 2*len(s.Hunks))
	for i, h := range s.Hunks {
		positions = append(positions, position{h.Start, i, false}, position{h.End, i, true})
	}
	sort.Slice(positions, func(i, j int) bool { return positions[i].offset < positions[j].offset })
	byteIndex, units := 0, 0
	for _, p := range positions {
		for byteIndex < p.offset {
			r, size := utf8.DecodeRuneInString(s.Draft[byteIndex:])
			byteIndex += size
			units++
			if r > 0xffff {
				units++
			}
		}
		if p.end {
			s.Hunks[p.index].End = units
		} else {
			s.Hunks[p.index].Start = units
		}
	}
	return s
}
