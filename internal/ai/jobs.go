package ai

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

type Job struct {
	ID         string `json:"id"`
	SnapshotID string `json:"snapshot_id"`
	Version    int    `json:"version"`
	Status     string `json:"status"`
	Completed  int    `json:"completed"`
	Total      int    `json:"total"`
	Error      string `json:"error,omitempty"`
}
type jobState struct {
	Job
	requestVersion int
	cancel         context.CancelFunc
	done           chan struct{}
	notified       sync.Once
	waiters        int
}

func (j *jobState) notify() { j.notified.Do(func() { close(j.done) }) }

// SectionCall owns usage accounting for one real provider request. There are no
// transport retries; a bounded output correction remains individually accounted.
type SectionCall func(context.Context, Configuration, []Message, string, string, string) (Reply, error)

func (m *Manager) PlanTurn(id, owner, prompt string, version int, thinking ...bool) (Plan, error) {
	m.mu.Lock()
	s, err := m.find(id, owner)
	if err != nil {
		m.mu.Unlock()
		return Plan{}, err
	}
	if s.busy || s.planning {
		m.mu.Unlock()
		return Plan{}, ErrBusy
	}
	if s.Version != version {
		m.mu.Unlock()
		return Plan{}, errors.New("AI draft changed; plan the request again")
	}
	if !ValidText(prompt, 16<<10) || strings.TrimSpace(prompt) == "" {
		m.mu.Unlock()
		return Plan{}, errors.New("enter a prompt of at most 16 KiB")
	}
	if s.turns >= 20 {
		m.mu.Unlock()
		return Plan{}, errors.New("20-turn limit reached; start a new session")
	}
	refs, err := s.requestedReferences(prompt)
	if err != nil {
		m.mu.Unlock()
		return Plan{}, err
	}
	useThinking := len(thinking) > 0 && thinking[0]
	if useThinking && !s.Configuration.ThinkingControllable {
		m.mu.Unlock()
		return Plan{}, errors.New("thinking cannot be controlled for this model; reopen AI")
	}
	s.planning = true
	planningLease := s.planEpoch
	planningSession := s
	defer func() { m.mu.Lock(); planningSession.planning = false; m.mu.Unlock() }()
	p := Plan{Whole: len(thinking) > 1 && thinking[1], neighbourBytes: 768, ID: ID(), Version: version, source: s.Draft, prompt: prompt, scope: s.Scope, history: append([]Message(nil), s.history...), review: append([]Hunk(nil), s.Hunks...), references: refs}
	if s.Configuration.ThinkingControllable {
		p.thinking = &useThinking
	}
	c, ctx := s.Configuration, s.ctx
	p.nativeSchema = c.StructuredOutput
	m.mu.Unlock()
	select {
	case m.planSlots <- struct{}{}:
		defer func() { <-m.planSlots }()
	default:
		return Plan{}, ErrBusy
	}
	p.parallel = m.parallel(c)
	capacity := m.Provider.planningCapacity(ctx, c)
	if err = p.prepareSections(capacity); err != nil {
		return Plan{}, err
	}
	if err = ctx.Err(); err != nil {
		return Plan{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err = m.find(id, owner)
	if err != nil {
		return Plan{}, err
	}
	if s.planEpoch != planningLease {
		return Plan{}, ErrCancelled
	}
	if s.busy {
		return Plan{}, ErrBusy
	}
	if s.Version != version {
		return Plan{}, errors.New("AI draft changed; plan the request again")
	}
	s.plan = &p
	return p, nil
}

func (m *Manager) StartJob(id, owner, planID string, version int, call SectionCall) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Job{}, err
	}
	// Repeating an acknowledged or ambiguously delivered start must never bill
	// twice. The frozen plan/version is the idempotency identity for this job.
	if s.job != nil && s.job.SnapshotID == planID && s.job.requestVersion == version {
		return s.job.Job, nil
	}
	if s.busy || s.planning {
		return Job{}, ErrBusy
	}
	p := s.plan
	if p == nil || p.ID != planID || p.Version != version || s.Version != version {
		return Job{}, errors.New("AI plan is stale; submit the request again")
	}
	// One bounded goroutine pool per open session; at most four sessions exist.
	ctx, cancel := context.WithTimeout(s.ctx, time.Hour)
	j := &jobState{requestVersion: version, Job: Job{ID: ID(), SnapshotID: p.ID, Version: version, Status: "running", Total: p.initialCalls()}, cancel: cancel, done: make(chan struct{})}
	s.job = j
	s.plan = nil
	s.busy = true
	s.turns++
	c := s.Configuration
	c.Thinking = p.thinking
	go m.runJob(ctx, s.ID, owner, s.NoteID, c, p, j, call)
	return j.Job, nil
}
func (m *Manager) Job(id, owner string) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return Job{}, err
	}
	if s.job == nil {
		return Job{}, errors.New("no AI job is active")
	}
	return s.job.Job, nil
}

// WaitJob returns as soon as the final result is published. Long polling avoids
// delaying fast replies and avoids repeated requests while the provider works.
func (m *Manager) WaitJob(ctx context.Context, id, owner string, wait time.Duration) (Job, error) {
	m.mu.Lock()
	s, err := m.find(id, owner)
	if err != nil {
		m.mu.Unlock()
		return Job{}, err
	}
	j := s.job
	if j == nil {
		m.mu.Unlock()
		return Job{}, errors.New("no AI job is active")
	}
	if j.Status != "running" {
		result := j.Job
		m.mu.Unlock()
		return result, nil
	}
	if j.waiters >= 2 {
		m.mu.Unlock()
		return Job{}, ErrBusy
	}
	j.waiters++
	sessionCtx := s.ctx
	m.mu.Unlock()
	defer func() { m.mu.Lock(); j.waiters--; m.mu.Unlock() }()
	timer := time.NewTimer(min(max(wait, time.Millisecond), 25*time.Second))
	defer timer.Stop()
	select {
	case <-j.done:
	case <-timer.C:
	case <-sessionCtx.Done():
		return Job{}, ErrSession
	case <-ctx.Done():
		return Job{}, ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err = m.find(id, owner)
	if err != nil {
		return Job{}, err
	}
	if s.job != j {
		return Job{}, errors.New("AI request changed; refresh the conversation")
	}
	return j.Job, nil
}

func (m *Manager) CancelJob(id, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return err
	}
	// Revoke both already planned and in-flight planning work before acknowledging.
	s.planEpoch++
	s.plan = nil
	if s.job != nil && s.job.Status == "running" {
		s.job.cancel()
		s.job.Status = "cancelled"
		s.job.notify()
		s.job.Error = ErrCancelled.Error()
		s.busy = false
	}
	return nil
}

// The server limit is both the default and the ceiling for a configuration.
func (m *Manager) parallel(c Configuration) int {
	if c.Concurrency > 0 {
		return min(c.Concurrency, cap(m.slots))
	}
	return cap(m.slots)
}
func (m *Manager) acquire(ctx context.Context) (func(), error) {
	select {
	case m.slots <- struct{}{}:
		return func() { <-m.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (m *Manager) runJob(ctx context.Context, id, owner, noteID string, c Configuration, p *Plan, j *jobState, call SectionCall) {
	defer j.cancel()
	defer j.notify()
	var outcome []sectionResult
	var failure error
	sectioned := len(p.ranges) > 1
	if p.routed {
		outcome, sectioned, failure = m.runRouted(ctx, c, p, j, id, noteID, call)
	} else {
		outcome, failure = m.runSections(ctx, id, p, j, len(p.ranges), m.editWork(c, p, j, id, noteID, call))
	}
	results := make([][]Hunk, len(outcome))
	answers := make([]string, len(outcome))
	revisions := make([][]proposalRevision, len(outcome))
	hunkCount := 0
	for i, part := range outcome {
		results[i], answers[i], revisions[i] = part.hunks, part.answer, part.revised
		hunkCount += len(part.hunks)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	// Closing, cancelling, or starting another turn revokes this lease. A late
	// worker cannot clear a newer turn's lock or publish its suggestions.
	if s == nil || s.owner != owner || s.job != j || j.Status != "running" || s.Version != p.Version {
		return
	}
	s.busy = false
	if failure == nil && ctx.Err() != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			failure = errors.New("AI job reached its one-hour deadline; no changes were published")
		} else {
			failure = ErrCancelled
		}
	}
	if failure != nil {
		j.Status = "failed"
		j.Error = failure.Error()
		return
	}
	hunks := make([]Hunk, 0, hunkCount)
	size := len(p.source)
	for _, section := range results {
		for _, h := range section {
			size += len(h.After) - len(h.Before)
			hunks = append(hunks, h)
		}
	}
	if size > MaxSnapshot {
		j.Status = "failed"
		j.Error = "combined draft exceeds 1 MiB; no changes were published"
		return
	}
	sort.Slice(hunks, func(i, k int) bool { return hunks[i].Start < hunks[k].Start })
	for i := 1; i < len(hunks); i++ {
		if hunks[i].Start < hunks[i-1].End || hunks[i].Start == hunks[i-1].Start {
			j.Status = "failed"
			j.Error = "suggestions overlap; no changes were published"
			return
		}
	}
	revised := []proposalRevision{}
	for _, part := range revisions {
		revised = append(revised, part...)
	}
	var publishErr error
	if len(p.references) > 0 {
		publishErr = s.publishScopedSuggestions(hunks, revised)
	} else {
		publishErr = s.publishSuggestions(hunks)
	}
	if err := publishErr; err != nil {
		j.Status = "failed"
		j.Error = err.Error()
		return
	}
	acknowledgement := ""
	if len(hunks) > 0 {
		acknowledgement = ReviewChangesAnswer
	} else if len(revised) > 0 {
		acknowledgement = RevisedSuggestionsAnswer
	}
	s.Answer = mergeAnswers(answers, acknowledgement)
	if sectioned && acknowledgement == "" && s.Answer != NoChangesAnswer {
		s.Answer = "These answers cover separate parts of the shared text. Share a smaller selection for a summary or comparison.\n\n" + s.Answer
	}
	// Retain concise conversation, not every section's rewritten text. The next
	// turn receives the accepted draft as its authoritative context.
	if len(s.history) > 32 {
		s.history = append([]Message(nil), s.history[len(s.history)-32:]...)
	}
	s.history = append(s.history, Message{"user", p.prompt}, Message{"assistant", s.Answer})
	bytes := 0
	for _, v := range s.history {
		bytes += len(v.Content)
	}
	for bytes > 32<<10 && len(s.history) > 2 {
		bytes -= len(s.history[0].Content) + len(s.history[1].Content)
		s.history = s.history[2:]
	}
	s.Version++
	j.Version = s.Version
	j.Status = "completed"
}
