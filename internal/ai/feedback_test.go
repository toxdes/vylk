package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func feedbackRequest() []Message {
	return []Message{{Role: "system", Content: SystemPrompt}, {Role: "user", Content: `{"scope":"note","blocks":[{"id":"b0_0","text":"original"}],"references":[],"request":"fix typos"}`}}
}

func TestMalformedReplyGetsValidationFeedbackWithoutChangingTheRequest(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	messages := feedbackRequest()
	calls := 0
	_, err := m.CompleteWithFeedback(context.Background(), Configuration{}, messages, "note", "session", "turn", func(_ context.Context, _ Configuration, next []Message, note, session, turn string) (Reply, error) {
		calls++
		if note != "note" || session != "session" || turn != "turn" {
			t.Fatal("usage attribution changed")
		}
		if calls == 1 {
			return Reply{}, &OutputError{Reason: "response must not be fenced", raw: "```json\n{}\n```"}
		}
		var original, corrected map[string]json.RawMessage
		_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &original)
		_ = json.Unmarshal([]byte(next[len(next)-1].Content), &corrected)
		var feedback struct{ Error, Previous string }
		var data struct {
			Error    string `json:"error"`
			Previous string `json:"previous_response"`
		}
		if err := json.Unmarshal(corrected["validation_feedback"], &data); err != nil {
			t.Fatal(err)
		}
		feedback.Error, feedback.Previous = data.Error, data.Previous
		if feedback.Error != "response must not be fenced" || feedback.Previous != "```json\n{}\n```" {
			t.Fatal(feedback)
		}
		delete(corrected, "validation_feedback")
		first, _ := json.Marshal(original)
		second, _ := json.Marshal(corrected)
		if string(first) != string(second) || next[0] != messages[0] {
			t.Fatal("frozen context or instructions changed")
		}
		return Reply{Answer: NoChangesAnswer, Changes: []BlockChange{}}, nil
	}, func(Reply) error { return nil })
	if err != nil || calls != 2 || strings.Contains(messages[len(messages)-1].Content, "validation_feedback") {
		t.Fatal(err, calls)
	}
}

func TestCorrectionLimitAndNonOutputFailures(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure error
		want    int
	}{
		{"invalid output", &OutputError{Reason: "invalid JSON", raw: "not json"}, 3},
		{"network", errors.New("provider connection failed"), 1},
		{"timeout", ErrTimeout, 1},
		{"cancelled", context.Canceled, 1},
		{"accounting", errors.New("could not record usage"), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := NewManager()
			defer m.Stop()
			calls := 0
			_, err := m.CompleteWithFeedback(context.Background(), Configuration{}, feedbackRequest(), "n", "s", "t", func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
				calls++
				return Reply{}, tc.failure
			}, func(Reply) error { return nil })
			if err == nil || calls != tc.want {
				t.Fatal(err, calls)
			}
		})
	}
}

func TestSecondAutomaticCorrectionUsesLatestFailureAndAccountsEveryCall(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	calls, finalized := 0, 0
	_, err := m.CompleteWithFeedback(context.Background(), Configuration{}, feedbackRequest(), "n", "s", "t", func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		calls++
		if finalized != calls-1 {
			t.Fatal("accounting lagged behind retry")
		}
		if calls == 3 {
			var input struct {
				Feedback struct {
					Previous string `json:"previous_response"`
				} `json:"validation_feedback"`
			}
			_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
			if !strings.Contains(input.Feedback.Previous, "second") {
				t.Fatal("reused first rejected response")
			}
		}
		answer := []string{"first", "second", "valid"}[calls-1]
		return (Reply{Answer: answer, Changes: []BlockChange{}}).WithUsageFinalizer(func(error) error { finalized++; return nil }), nil
	}, func(r Reply) error {
		if r.Answer != "valid" {
			return errors.New("invalid anchor")
		}
		return nil
	})
	if err != nil || calls != 3 || finalized != 3 {
		t.Fatal(err, calls, finalized)
	}
	_, err = m.CompleteWithFeedback(context.Background(), Configuration{}, feedbackRequest(), "n", "s", "t", func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
		return Reply{}, &OutputError{Reason: "internal schema details", raw: "bad"}
	}, func(Reply) error { return nil })
	var technical *OutputError
	if err == nil || err.Error() != correctionFailureMessage || !errors.As(err, &technical) || technical.Reason != "internal schema details" {
		t.Fatal("details leaked or were lost", err)
	}
}

func TestValidationUsageFinalizationRunsOnceBeforeCorrection(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	calls := 0
	outcomes := []bool{}
	_, err := m.CompleteWithFeedback(context.Background(), Configuration{}, feedbackRequest(), "n", "s", "t", func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
		calls++
		call := calls
		return (Reply{Answer: "result", Changes: []BlockChange{}}).WithUsageFinalizer(func(result error) error {
			if len(outcomes) != call-1 {
				t.Fatal("usage not finalized before next attempt")
			}
			outcomes = append(outcomes, result == nil)
			return nil
		}), nil
	}, func(Reply) error {
		if calls == 1 {
			return errors.New("wrong identifier")
		}
		return nil
	})
	if err != nil || calls != 2 || len(outcomes) != 2 || outcomes[0] || !outcomes[1] {
		t.Fatal(err, calls, outcomes)
	}
}

func TestAccountingFailureAndCancellationNeverTriggerCorrection(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		m := NewManager()
		defer m.Stop()
		ctx, cancel := context.WithCancel(context.Background())
		calls, finished := 0, 0
		_, err := m.CompleteWithFeedback(ctx, Configuration{}, feedbackRequest(), "n", "s", "t", func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
			calls++
			return (Reply{Answer: "result"}).WithUsageFinalizer(func(result error) error {
				finished++
				if cancelled {
					if !errors.Is(result, context.Canceled) {
						t.Fatal("cancelled call not accounted as cancelled")
					}
					return nil
				}
				return errors.New("accounting failed")
			}), nil
		}, func(Reply) error {
			if cancelled {
				cancel()
			}
			return errors.New("invalid identifiers")
		})
		cancel()
		if err == nil || calls != 1 || finished != 1 {
			t.Fatal(err, calls, finished)
		}
	}
}

func TestWrongReferenceModeRequiresANewStructuredReply(t *testing.T) {
	m, s, source := pendingReferenceFixture(t)
	plan, err := m.PlanTurn(s.ID, "owner", "@3 redo", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	_, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, func(_ context.Context, _ Configuration, messages []Message, _, _, _ string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		calls++
		if calls == 1 {
			return Reply{Answer: "Changed", Changes: []BlockChange{{ID: plan.blocks[0][0].ID, Before: plan.blocks[0][0].Text, After: plan.blocks[0][0].Text}}}, nil
		}
		var input struct {
			Feedback *struct {
				Error string `json:"error"`
			} `json:"validation_feedback"`
		}
		_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
		if input.Feedback == nil || !strings.Contains(input.Feedback.Error, "instead of revising") {
			t.Fatal("missing actionable feedback")
		}
		return Reply{Answer: "Removed that suggestion.", Changes: []BlockChange{{ID: "@3", Before: "I like Amazon.", After: "I likes bezos daddy."}}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if job := waitJob(t, m, s.ID); job.Status != "completed" {
		t.Fatal(job.Error)
	}
	current, _ := m.Metadata(s.ID, "owner")
	if calls != 2 || current.Draft != source || len(current.Hunks) != 2 || current.Hunks[0].Ref != "@1" || current.Hunks[1].Ref != "@2" {
		t.Fatal("repair mutated unrelated state", calls, current)
	}
}
