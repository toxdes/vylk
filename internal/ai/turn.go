package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

const maxFindingBytes = 2 << 10
const maxMergePasses = 6

type sectionResult struct {
	hunks   []Hunk
	revised []proposalRevision
	answer  string
}

type sectionWork func(ctx context.Context, index int) (sectionResult, error)

// runSections runs work for each index on the configured parallel calls. The
// first failure cancels the job; a failed job publishes nothing.
func (m *Manager) runSections(ctx context.Context, id string, p *Plan, j *jobState, count int, work sectionWork) ([]sectionResult, error) {
	results := make([]sectionResult, count)
	var mu sync.Mutex
	var failure error
	next, totalBytes, hunkCount, answerBytes := 0, 0, 0, 0
	answerLimit := MaxContext
	if count > 1 {
		answerLimit = 64 << 10
	}
	var workers sync.WaitGroup
	for range min(max(1, p.parallel), count) {
		workers.Go(func() {
			for {
				mu.Lock()
				if failure != nil || next >= count || ctx.Err() != nil {
					mu.Unlock()
					return
				}
				index := next
				next++
				mu.Unlock()
				var queued time.Time
				if m.Provider.debug != nil {
					queued = time.Now()
				}
				release, err := m.acquire(ctx)
				if err != nil {
					return
				}
				sectionCtx, cancel := context.WithTimeout(ctx, Timeout)
				if !queued.IsZero() {
					sectionCtx = context.WithValue(sectionCtx, debugQueueKey{}, time.Since(queued).Milliseconds())
				}
				result, err := work(sectionCtx, index)
				cancel()
				release()
				mu.Lock()
				if err == nil {
					for _, h := range result.hunks {
						totalBytes += len(h.Before) + len(h.After)
					}
					hunkCount += len(result.hunks)
					answerBytes += len(result.answer)
					if totalBytes > 2*MaxSnapshot || hunkCount > 512 || answerBytes > answerLimit {
						err = errors.New("combined suggestions exceed the review limit; share a smaller selection")
					}
				}
				if err != nil {
					if failure == nil {
						failure = jobFailure(err)
						j.cancel()
					}
					mu.Unlock()
					return
				}
				results[index] = result
				mu.Unlock()
				m.jobProgress(id, j, 1, 0)
			}
		})
	}
	workers.Wait()
	return results, failure
}

func jobFailure(err error) error {
	var correction *correctionError
	if errors.As(err, &correction) {
		return err
	}
	return fmt.Errorf("%w; no changes were published", err)
}

// Total grows as routing chooses more calls; Completed counts finished calls.
func (m *Manager) jobProgress(id string, j *jobState, completed, total int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[id]; s != nil && s.job == j && j.Status == "running" {
		j.Completed += completed
		j.Total += total
		s.timer.Reset(30 * time.Minute)
	}
}

func withoutTools(validate func(Reply) error) func(Reply) error {
	return func(reply Reply) error {
		if len(reply.Tools) > 0 {
			return errors.New("tools are not available for this request; return tools=[]")
		}
		return validate(reply)
	}
}

func answerOnly(reply Reply) error {
	if len(reply.Changes) > 0 {
		return errors.New("this request has no editable blocks; changes must be []")
	}
	return nil
}

// toolLoop answers a request, running the read-only tool rounds the model asks
// for until it answers, chooses a route, or the turn's rounds run out.
func (m *Manager) toolLoop(ctx context.Context, c Configuration, messages []Message, tools *turnTools, names []string, noteID, id, turnID string, call SectionCall, validate func(Reply) error) (Reply, error) {
	for {
		offered := tools.offered(names)
		reply, err := m.CompleteWithFeedback(ctx, c, messages, noteID, id, turnID, call, func(reply Reply) error {
			if len(reply.Tools) > 0 {
				return validateToolCalls(reply.Tools, offered, len(reply.Changes))
			}
			return validate(reply)
		})
		if err != nil || len(reply.Tools) == 0 || isRoute(reply.Tools[0].Name) {
			return reply, err
		}
		budget := m.toolBudget(ctx, c, messages, reply.raw)
		if budget < 2<<10 {
			tools.rounds = 1
		}
		results := tools.run(reply.Tools, budget)
		data, _ := json.Marshal(toolEnvelope{Scope: tools.scope, Results: results, Available: tools.offered(names), RoundsLeft: tools.rounds, MaxCallsPerTry: maxToolCalls})
		messages = append(append([]Message(nil), messages...), Message{"assistant", reply.raw}, Message{"user", string(data)})
	}
}

// Results must leave room for the next request's reply. Budget one byte per
// estimated token, the estimator's worst case for non-ASCII text.
func (m *Manager) toolBudget(ctx context.Context, c Configuration, messages []Message, raw string) int {
	capacity := m.Provider.planningCapacity(ctx, c)
	used := estimatedInputTokens(append(append([]Message(nil), messages...), Message{"assistant", raw})) + outputReserve(capacity) + 1024
	return max(0, capacity.Tokens-used)
}

// runRouted lets the model choose how a multi-section turn reads the text.
func (m *Manager) runRouted(ctx context.Context, c Configuration, p *Plan, j *jobState, id, noteID string, call SectionCall) ([]sectionResult, bool, error) {
	tools := newTurnTools(p.source, p.scope)
	routed, err := m.runSections(ctx, id, p, j, 1, func(ctx context.Context, _ int) (sectionResult, error) {
		reply, err := m.toolLoop(ctx, c, p.routeMessages(tools), tools, p.routeTools(), noteID, id, j.ID, call, answerOnly)
		result := sectionResult{answer: reply.Answer}
		if err == nil && len(reply.Tools) > 0 {
			result.answer = reply.Tools[0].Name
		}
		return result, err
	})
	if err != nil {
		return nil, false, err
	}
	switch route := routed[0].answer; route {
	case routeEditSections:
		m.jobProgress(id, j, 0, len(p.ranges))
		results, err := m.runSections(ctx, id, p, j, len(p.ranges), m.editWork(c, p, j, id, noteID, call))
		return results, true, err
	case routeReadWhole:
		m.jobProgress(id, j, 0, 1)
		results, err := m.runSections(ctx, id, p, j, 1, m.wholeWork(c, p, j, id, noteID, call, tools))
		return results, false, err
	case routeCombine:
		results, err := m.combine(ctx, c, p, j, id, noteID, call, tools)
		return results, false, err
	}
	return routed, false, nil
}

func (m *Manager) editWork(c Configuration, p *Plan, j *jobState, id, noteID string, call SectionCall) sectionWork {
	return func(ctx context.Context, index int) (sectionResult, error) {
		r := p.ranges[index]
		var result sectionResult
		validate := func(reply Reply) error {
			var err error
			result.hunks, result.revised, err = referencedReplyHunks(p.source, p.scope, p.blocks[index], p.references, r, reply)
			if err != nil {
				return err
			}
			return validateReferencedChanges(p.references, p.source, r, result.hunks)
		}
		var reply Reply
		var err error
		if len(p.ranges) == 1 && p.toolsEnabled() {
			tools := newTurnTools(p.source, p.scope)
			reply, err = m.toolLoop(ctx, c, p.request(index, "", tools, textTools), tools, textTools, noteID, id, j.ID, call, validate)
		} else {
			reply, err = m.CompleteWithFeedback(ctx, c, p.messages(index), noteID, id, j.ID, call, withoutTools(validate))
		}
		if err != nil {
			return result, err
		}
		for i := range result.hunks {
			result.hunks[i].Start += r.Start
			result.hunks[i].End += r.Start
		}
		result.answer = reply.Answer
		return result, nil
	}
}

func (m *Manager) wholeWork(c Configuration, p *Plan, j *jobState, id, noteID string, call SectionCall, tools *turnTools) sectionWork {
	whole := Section{0, len(p.source)}
	return func(ctx context.Context, _ int) (sectionResult, error) {
		var result sectionResult
		reply, err := m.toolLoop(ctx, c, p.wholeMessages(tools), tools, textTools, noteID, id, j.ID, call, func(reply Reply) error {
			var err error
			result.hunks, result.revised, err = referencedReplyHunks(p.source, p.scope, p.wholeBlocks, nil, whole, reply)
			return err
		})
		result.answer = reply.Answer
		return result, err
	}
}

// combine answers whole-text questions that do not fit one request: each
// section reports findings, oversized findings merge in batches, then one
// request answers from them.
func (m *Manager) combine(ctx context.Context, c Configuration, p *Plan, j *jobState, id, noteID string, call SectionCall, tools *turnTools) ([]sectionResult, error) {
	m.jobProgress(id, j, 0, len(p.ranges))
	parts, err := m.runSections(ctx, id, p, j, len(p.ranges), func(ctx context.Context, index int) (sectionResult, error) {
		reply, err := m.CompleteWithFeedback(ctx, c, p.request(index, "collect_findings", nil, nil), noteID, id, j.ID, call, withoutTools(answerOnly))
		return sectionResult{answer: reply.Answer}, err
	})
	if err != nil {
		return nil, err
	}
	findings := make([]finding, len(parts))
	for i, part := range parts {
		findings[i] = finding{Part: i + 1, Text: truncateText(part.answer, maxFindingBytes)}
	}
	capacity := m.Provider.planningCapacity(ctx, c)
	for pass := 0; pass < maxMergePasses && len(findings) > 1 && !fitsWindow(p.combineMessages(findings, tools, false), capacity); pass++ {
		batches := batchFindings(p, findings, capacity)
		m.jobProgress(id, j, 0, len(batches))
		merged, err := m.runSections(ctx, id, p, j, len(batches), func(ctx context.Context, index int) (sectionResult, error) {
			reply, err := m.CompleteWithFeedback(ctx, c, p.combineMessages(batches[index], nil, true), noteID, id, j.ID, call, withoutTools(answerOnly))
			return sectionResult{answer: reply.Answer}, err
		})
		if err != nil {
			return nil, err
		}
		findings = make([]finding, len(merged))
		for i, part := range merged {
			findings[i] = finding{Part: i + 1, Text: truncateText(part.answer, maxFindingBytes)}
		}
	}
	m.jobProgress(id, j, 0, 1)
	return m.runSections(ctx, id, p, j, 1, func(ctx context.Context, _ int) (sectionResult, error) {
		reply, err := m.toolLoop(ctx, c, p.combineMessages(findings, tools, false), tools, textTools, noteID, id, j.ID, call, answerOnly)
		return sectionResult{answer: reply.Answer}, err
	})
}

func fitsWindow(messages []Message, capacity modelContext) bool {
	return capacity.Tokens == 0 || estimatedInputTokens(messages)+outputReserve(capacity)+1024 <= capacity.Tokens
}

// Consecutive findings that fit one merge request; every batch takes at least
// two findings so each pass shrinks the list.
func batchFindings(p *Plan, findings []finding, capacity modelContext) [][]finding {
	batches := [][]finding{}
	for start := 0; start < len(findings); {
		end := min(start+2, len(findings))
		for end < len(findings) && fitsWindow(p.combineMessages(findings[start:end+1], nil, true), capacity) {
			end++
		}
		batches = append(batches, findings[start:end])
		start = end
	}
	return batches
}

func truncateText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:runeFloor(text, limit)]
}
