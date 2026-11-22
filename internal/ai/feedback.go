package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// OutputError identifies a finished model reply which violates the requested
// structure. Transport, timeout, provider and accounting failures are not retries.
type OutputError struct {
	Reason string
	raw    string
}

func (e *OutputError) Error() string { return e.Reason }

const maxCorrectionAttempts = 2
const correctionFailureMessage = "Couldn't complete this request. Your note hasn't changed."

// Technical details remain available to logs and error inspection, not UI copy.
type correctionError struct{ cause error }

func (e *correctionError) Error() string { return correctionFailureMessage }
func (e *correctionError) Unwrap() error { return e.cause }

// WithUsageFinalizer transfers one successful provider call's accounting to the
// validation orchestrator, which finalizes it exactly once before any retry.
func (r Reply) WithUsageFinalizer(finish func(error) error) Reply { r.finishUsage = finish; return r }

// RawResponse stays on the server for validation feedback and never enters the
// browser session or retained conversation history.
func (r Reply) RawResponse() string { return r.raw }

func correctionMessages(messages []Message, raw string, validation error, changes []BlockChange) ([]Message, error) {
	if len(messages) == 0 || messages[len(messages)-1].Role != "user" {
		return nil, errors.New("cannot correct a response without its original request")
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal([]byte(messages[len(messages)-1].Content), &envelope) != nil || envelope == nil {
		return nil, errors.New("cannot correct a response without its original request")
	}
	feedback, err := json.Marshal(struct {
		Error       string            `json:"error"`
		Previous    string            `json:"previous_response"`
		Instruction string            `json:"instruction"`
		Anchor      *anchorDiagnostic `json:"anchor_error,omitempty"`
	}{validation.Error(), raw, "The previous response failed validation. Return a corrected complete JSON reply for the same request and frozen context, following the required format and allowed IDs. anchor_error.change_index is zero-based in the previous changes array; matching_block_id, when present, reports a unique exact occurrence in another editable target, not an instruction to move the edit. Recheck the intended correction. Do not explain the validation failure outside JSON.", diagnoseAnchor(envelope, changes, validation)})
	if err != nil {
		return nil, err
	}
	envelope["validation_feedback"] = feedback
	content, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	next := append([]Message(nil), messages...)
	next[len(next)-1].Content = string(content)
	size := 0
	for _, m := range next {
		size += len(m.Content)
	}
	if size > MaxHistory {
		return nil, errors.New("the invalid response is too large to correct safely; retry with less shared text")
	}
	return next, nil
}

// CompleteWithFeedback makes at most two correction calls for malformed output
// or failed local reply validation. Every call passes through normal accounting;
// all attempts use one frozen request, cancellation scope and concurrency slot.
func (m *Manager) CompleteWithFeedback(ctx context.Context, c Configuration, messages []Message, noteID, sessionID, turnID string, call SectionCall, validate func(Reply) error) (Reply, error) {
	request := messages
	for attempt := 0; attempt <= maxCorrectionAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return Reply{}, err
		}
		if err := m.Provider.Preflight(ctx, c, request); err != nil {
			if attempt > 0 && ctx.Err() == nil {
				return Reply{}, &correctionError{cause: err}
			}
			return Reply{}, err
		}
		callCtx := ctx
		if m.Provider.debug != nil {
			callCtx = context.WithValue(ctx, debugCallKey{}, debugCall{TurnID: turnID, Attempt: attempt + 1})
		}
		reply, err := call(callCtx, c, request, noteID, sessionID, turnID)
		validationFailed := false
		if err == nil {
			err = ctx.Err()
			if err == nil {
				err = validate(reply)
				validationFailed = err != nil && !errors.Is(err, ErrSession) && !errors.Is(err, ErrBusy)
			}
		}
		if cancelled := ctx.Err(); cancelled != nil {
			err = cancelled
			validationFailed = false
		}
		if finish := reply.finishUsage; finish != nil {
			reply.finishUsage = nil
			if accountingErr := finish(err); accountingErr != nil {
				return Reply{}, accountingErr
			}
		}
		if err == nil {
			return reply, nil
		}
		if ctx.Err() != nil {
			return Reply{}, ctx.Err()
		}
		var invalid *OutputError
		malformed := errors.As(err, &invalid)
		if !malformed && !validationFailed {
			return Reply{}, err
		}
		if m.Provider.debug != nil {
			debug := providerDebugExchange{output: m.Provider.debug, id: turnID, key: c.Key, started: time.Now(), call: debugCall{TurnID: turnID, Attempt: attempt + 1}}
			debug.emit(providerDebugEntry{Phase: "validation_failed", Model: c.Model}, err)
		}
		if attempt == maxCorrectionAttempts {
			return Reply{}, &correctionError{cause: err}
		}
		raw := reply.raw
		if malformed {
			raw = invalid.raw
		}
		if raw == "" {
			encoded, encodeErr := json.Marshal(struct {
				Answer  string        `json:"answer"`
				Changes []BlockChange `json:"changes"`
			}{reply.Answer, reply.Changes})
			if encodeErr != nil {
				return Reply{}, err
			}
			raw = string(encoded)
		}
		request, err = correctionMessages(messages, raw, err, reply.Changes)
		if err != nil {
			return Reply{}, &correctionError{cause: err}
		}
		if m.Provider.debug != nil {
			ctx = context.WithValue(ctx, debugQueueKey{}, int64(0))
		}
	}
	return Reply{}, &correctionError{cause: errors.New("model correction limit reached")}
}

// ValidatePendingReply checks a legacy synchronous turn without publishing it.
// Finish performs the same validation again while atomically publishing results.
func (m *Manager) ValidatePendingReply(id, owner string, reply Reply) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.find(id, owner)
	if err != nil {
		return err
	}
	if !s.busy {
		return ErrSession
	}
	refs, err := s.requestedReferences(s.pendingPrompt)
	if err != nil {
		return err
	}
	hunks, _, err := referencedReplyHunks(s.Draft, s.Scope, s.pendingBlocks, refs, Section{0, len(s.Draft)}, reply)
	if err != nil {
		return err
	}
	return validateReferencedChanges(refs, s.Draft, Section{0, len(s.Draft)}, hunks)
}
