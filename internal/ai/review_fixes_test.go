package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHistoricalReferenceCannotRelocateToSurvivingDuplicate(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "foo\n\nbar", Configuration{})
	for _, change := range []Edit{{Before: "foo", After: "bar"}, {Before: "bar", After: "baz"}} {
		_, messages, _, err := m.Begin(s.ID, "owner", "edit", s.Version)
		if err != nil {
			t.Fatal(err)
		}
		// The second accepted change explicitly targets offset zero, not a text search.
		var input providerContext
		_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &input)
		s, err = m.Finish(s.ID, "owner", "{}", Reply{Changes: []BlockChange{{ID: input.Blocks[0].ID, Before: change.Before, After: change.After}}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		s, err = m.Review(s.ID, "owner", "accept_all", "", s.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	if s.Draft != "baz\n\nbar" {
		t.Fatal(s.Draft)
	}
	plan, err := m.PlanTurn(s.ID, "owner", "undo @1", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	input := plan.messages(0)
	var envelope providerContext
	_ = json.Unmarshal([]byte(input[len(input)-1].Content), &envelope)
	if len(envelope.Blocks) != 0 || len(envelope.References) != 1 || envelope.References[0].EditableHere {
		t.Fatal(envelope)
	}
	refs := plan.references
	if refs[0].positioned {
		t.Fatal("historical reference acquired a position by text search")
	}
	if err := validateReferencedChanges(refs, plan.source, plan.ranges[0], []Hunk{{Start: 5, End: 8, Before: "bar", After: "foo"}}); err == nil {
		t.Fatal("accepted relocation")
	}
	assertRevisionSchema(t, scopedResponseFormat(input), nil, true)
}

func TestNativeSchemasConstrainNormalBlocksAndPromptOnlyRequests(t *testing.T) {
	for _, scope := range []string{"note", "none"} {
		data, _ := json.Marshal(providerContext{Scope: scope, Blocks: []Block{{ID: "b0_0", Text: "one"}, {ID: "b0_15", Text: "two"}}})
		messages := []Message{{Role: "user", Content: string(data)}}
		if scope == "none" {
			assertRevisionSchema(t, scopedResponseFormat(messages), nil, true)
		} else {
			assertRevisionSchema(t, scopedResponseFormat(messages), []string{"b0_0", "b0_15"}, false)
		}
		c := Configuration{URL: "https://example.com/v1", OutputProfile: "json_schema", StructuredOutput: true}
		format, routing := structuredFormat(c, messages)
		if len(format) == 0 || routing != nil {
			t.Fatal("explicit generic profile was ignored")
		}
		c.OutputProfile = ""
		if format, _ := structuredFormat(c, messages); format != nil {
			t.Fatal("guessed support at generic endpoint")
		}
	}
}

func TestWholeContextModeUsesOneRequestOrRejectsBeforeDispatch(t *testing.T) {
	source := strings.Repeat("A short paragraph with useful context.\n\n", 700)
	for _, tc := range []struct {
		capacity modelContext
		fail     bool
	}{
		{modelContext{Tokens: 100000}, false}, {modelContext{Tokens: 4096}, true}, {modelContext{}, true},
	} {
		p := Plan{source: source, scope: "note", Whole: true}
		err := p.prepareSections(tc.capacity)
		if (err != nil) != tc.fail {
			t.Fatal(err, tc)
		}
		if err == nil && (p.Sections != 1 || p.ranges[0].End != len(source)) {
			t.Fatal("silently split whole-context task", p.ranges)
		}
	}
}

func TestJobStartIsIdempotentBeforeAndAfterCompletion(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "text", Configuration{})
	plan, err := m.PlanTurn(s.ID, "owner", "ideas", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	release := make(chan struct{})
	call := func(ctx context.Context, _ Configuration, _ []Message, _, _, _ string) (Reply, error) {
		calls.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
			return Reply{}, ctx.Err()
		}
		return Reply{Answer: "One answer.", Changes: []BlockChange{}}, nil
	}
	first, err := m.StartJob(s.ID, "owner", plan.ID, s.Version, call)
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.StartJob(s.ID, "owner", plan.ID, s.Version, call)
	if err != nil || again.ID != first.ID {
		t.Fatal(again, err)
	}
	metadata, _ := m.Metadata(s.ID, "owner")
	if metadata.CurrentJob == nil || metadata.CurrentJob.ID != first.ID {
		t.Fatal(metadata)
	}
	close(release)
	if job := waitJob(t, m, s.ID); job.Status != "completed" {
		t.Fatal(job)
	}
	again, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, call)
	if err != nil || again.ID != first.ID || calls.Load() != 1 {
		t.Fatal(again, calls.Load(), err)
	}
}

func TestCancellationRevokesAnUnstartedPlan(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "text", Configuration{})
	plan, err := m.PlanTurn(s.ID, "owner", "ideas", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.CancelJob(s.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	_, err = m.StartJob(s.ID, "owner", plan.ID, s.Version, func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
		calls.Add(1)
		return Reply{}, nil
	})
	if err == nil || calls.Load() != 0 {
		t.Fatal("cancelled plan was started", err, calls.Load())
	}
}

func TestCancellationRevokesInFlightPlanning(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	m.Provider.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
		once.Do(func() { close(entered) })
		select {
		case <-release:
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"model","context_length":32768}]}`))}, nil
	})
	s, _ := m.Create("owner", "note", "note", "text", Configuration{URL: "https://example.com/v1", Model: "model"})
	result := make(chan error, 1)
	go func() { _, err := m.PlanTurn(s.ID, "owner", "ideas", s.Version); result <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("planning did not start")
	}
	if err := m.CancelJob(s.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-result; !errors.Is(err, ErrCancelled) {
		t.Fatal("cancelled planning was published", err)
	}
}
