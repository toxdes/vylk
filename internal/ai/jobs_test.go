package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func waitJob(t *testing.T, m *Manager, id string) Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		j, err := m.Job(id, "owner")
		if err != nil {
			t.Fatal(err)
		}
		if j.Status != "running" {
			return j
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("job did not finish")
	return Job{}
}
func sectionText(messages []Message) string {
	var v struct {
		Blocks []Block `json:"blocks"`
	}
	_ = json.Unmarshal([]byte(messages[len(messages)-1].Content), &v)
	var text strings.Builder
	for _, block := range v.Blocks {
		text.WriteString(block.Text)
	}
	return text.String()
}
func TestMarkdownSectionCoverageAndContainers(t *testing.T) {
	source := "# Draft\r\n\r\n" + strings.Repeat("Short paragraph.\r\n\r\n", 30) + "- first\r\n  - nested\r\n\r\n  ```go\r\n  x := 1\r\n  ```\r\n- second\r\n\r\n| A | B |\r\n|---|---|\r\n| x | y |\r\n\r\n```\r\n# not a heading\r\n\r\ninside fence\r\n```\r\n"
	ranges, err := planSections(source, 140)
	if err != nil {
		t.Fatal(err)
	}
	if len(ranges) < 2 {
		t.Fatal("not split")
	}
	var combined strings.Builder
	for i, r := range ranges {
		if i == 0 && r.Start != 0 || i > 0 && r.Start != ranges[i-1].End {
			t.Fatal("gap or overlap")
		}
		combined.WriteString(source[r.Start:r.End])
		for _, protected := range []string{"  - nested\r\n\r\n  ```go\r\n  x := 1\r\n  ```", "| A | B |\r\n|---|---|\r\n| x | y |", "```\r\n# not a heading\r\n\r\ninside fence\r\n```"} {
			start := strings.Index(source, protected)
			end := start + len(protected)
			if r.Start > start && r.Start < end || r.End > start && r.End < end {
				t.Fatalf("split container at %+v: %q", r, protected)
			}
		}
	}
	if combined.String() != source {
		t.Fatal("coverage changed bytes")
	}
}
func TestSectionPlanningLimitsAndLargeSnapshot(t *testing.T) {
	if _, err := planSections(strings.Repeat("x", 20<<10), sectionTokens); err == nil {
		t.Fatal("split oversized indivisible paragraph")
	}
	if _, err := planSections(strings.Repeat("paragraph.\n\n", 10000), 100); err == nil {
		t.Fatal("unbounded sections")
	}
	if _, err := planSections(strings.Repeat("\n", maxPlanLines+1), sectionTokens); err == nil {
		t.Fatal("unbounded parser lines")
	}
	m := NewManager()
	defer m.Stop()
	if _, err := m.Create("owner", "note", "note", strings.Repeat("x", MaxSnapshot), Configuration{}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create("owner", "note", "note", strings.Repeat("x", MaxSnapshot+1), Configuration{}); err == nil {
		t.Fatal("accepted oversized snapshot")
	}
}
func TestJobsSerializeProvidersAndPublishAgainstSnapshot(t *testing.T) {
	for _, concurrency := range []int{1, 2} {
		t.Run(string(rune('0'+concurrency)), func(t *testing.T) {
			m := NewManager(concurrency)
			defer m.Stop()
			source := "# 🙂 Draft\n\n" + strings.Repeat("He go home.\n\n", 900)
			s, err := m.Create("owner", "note", "note", source, Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			p, err := m.PlanTurn(s.ID, "owner", "Fix grammar", 0)
			if err != nil {
				t.Fatal(err)
			}
			if p.Sections < 2 {
				t.Fatal("expected chunking")
			}
			var active, peak atomic.Int32
			call := func(ctx context.Context, c Configuration, messages []Message, note, session, turn string) (Reply, error) {
				if reply, ok := routeToSections(messages); ok {
					return reply, nil
				}
				n := active.Add(1)
				defer active.Add(-1)
				for old := peak.Load(); n > old; old = peak.Load() {
					if peak.CompareAndSwap(old, n) {
						break
					}
				}
				time.Sleep(5 * time.Millisecond)
				replacement := strings.ReplaceAll(sectionText(messages), "He go", "He goes")
				return Reply{Answer: "Corrected", Replacement: &replacement}, nil
			}
			j, err := m.StartJob(s.ID, "owner", p.ID, 0, call)
			if err != nil {
				t.Fatal(err)
			}
			if j.SnapshotID != p.ID {
				t.Fatal("missing snapshot identity")
			}
			if _, err := m.Review(s.ID, "owner", "accept_all", "", 0); !errors.Is(err, ErrBusy) {
				t.Fatal("review not locked", err)
			}
			if _, err := m.PlanTurn(s.ID, "owner", "follow-up", 0); !errors.Is(err, ErrBusy) {
				t.Fatal("follow-up not locked", err)
			}
			j = waitJob(t, m, s.ID)
			// The routing request counts as one completed call.
			if j.Status != "completed" || j.Completed != p.Sections+1 || j.Total != p.Sections+1 {
				t.Fatal(j)
			}
			if peak.Load() > int32(concurrency) || peak.Load() < int32(concurrency) {
				t.Fatalf("concurrency peak %d, want %d", peak.Load(), concurrency)
			}
			current, _ := m.Metadata(s.ID, "owner")
			if current.Answer != "Corrected" {
				t.Fatalf("internal processing leaked into reply: %q", current.Answer)
			}
			for i, h := range current.Hunks {
				if h.Ref != "@"+strconv.Itoa(i+1) {
					t.Fatal("references depend on worker completion order", current.Hunks)
				}
			}
			if current.Draft != source {
				t.Fatal("modified snapshot before review")
			}
			current, err = m.Review(s.ID, "owner", "accept_all", "", current.Version)
			if err != nil {
				t.Fatal(err)
			}
			if current.Draft != strings.ReplaceAll(source, "He go", "He goes") {
				t.Fatal("combined edits were inconsistent")
			}
			if again, err := m.StartJob(s.ID, "owner", p.ID, 0, call); err != nil || again.Status != "completed" {
				t.Fatal("idempotent start did not return completed job", again, err)
			}
			if _, err := m.StartJob(s.ID, "owner", p.ID, 999, call); err == nil {
				t.Fatal("accepted a mismatched request version")
			}
		})
	}
}
func TestFailedSectionDoesNotPublishPartialChanges(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", strings.Repeat("He go.\n\n", 1200), Configuration{})
	p, err := m.PlanTurn(s.ID, "owner", "fix", 0)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	_, err = m.StartJob(s.ID, "owner", p.ID, 0, func(ctx context.Context, c Configuration, messages []Message, note, session, turn string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		calls++
		if calls == 2 {
			return Reply{}, errors.New("provider failed")
		}
		replacement := strings.ReplaceAll(sectionText(messages), "go", "goes")
		return Reply{Replacement: &replacement}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, m, s.ID)
	current, _ := m.Metadata(s.ID, "owner")
	if j.Error != "provider failed; no changes were published" {
		t.Fatal("internal processing leaked into error", j.Error)
	}
	if j.Status != "failed" || j.Completed != 2 || len(current.Hunks) != 0 || current.Version != 0 {
		t.Fatal(j, current.Version)
	}
}
func TestCancelledLeaseCannotPublishIntoNewTurn(t *testing.T) {
	m := NewManager(2)
	defer m.Stop()
	s, _ := m.Create("owner", "note", "selection", "old text", Configuration{})
	p, _ := m.PlanTurn(s.ID, "owner", "old", 0)
	started, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	_, err := m.StartJob(s.ID, "owner", p.ID, 0, func(ctx context.Context, c Configuration, messages []Message, note, session, turn string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		close(started)
		<-release
		defer close(returned)
		v := "stale text"
		return Reply{Replacement: &v}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if err := m.CancelJob(s.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	p, err = m.PlanTurn(s.ID, "owner", "new", 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.StartJob(s.ID, "owner", p.ID, 0, func(ctx context.Context, c Configuration, messages []Message, note, session, turn string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		v := "new text"
		return Reply{Replacement: &v}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if j := waitJob(t, m, s.ID); j.Status != "completed" {
		t.Fatal(j)
	}
	close(release)
	<-returned
	current, _ := m.Metadata(s.ID, "owner")
	if len(current.Hunks) != 1 || current.Hunks[0].After != "new" {
		t.Fatalf("stale completion escaped lease: %+v", current.Hunks)
	}
}
func BenchmarkSectionPlan(b *testing.B) {
	source := strings.Repeat("## Heading\n\nA paragraph of ordinary Markdown with **emphasis**.\n\n", 1500)
	b.ReportAllocs()
	b.SetBytes(int64(len(source)))
	for b.Loop() {
		_, _ = planSections(source, sectionTokens)
	}
}

func TestAnswerOnlyJobPreservesPendingReview(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	session, err := m.Create("owner", "note", "selection", "weekly task", Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	run := func(prompt string, reply Reply) {
		t.Helper()
		plan, err := m.PlanTurn(session.ID, "owner", prompt, session.Version)
		if err != nil {
			t.Fatal(err)
		}
		_, err = m.StartJob(session.ID, "owner", plan.ID, session.Version, func(context.Context, Configuration, []Message, string, string, string) (Reply, error) {
			return reply, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if job := waitJob(t, m, session.ID); job.Status != "completed" {
			t.Fatal(job)
		}
		session, err = m.Metadata(session.ID, "owner")
		if err != nil {
			t.Fatal(err)
		}
	}
	run("make it realistic", Reply{Answer: "Updated weekly target", Edits: []Edit{{Before: "weekly task", After: "one task this week"}}})
	pending := session.Hunks[0]
	run("which model are you?", Reply{Answer: "I am an AI language model.", Edits: []Edit{}})
	if len(session.Hunks) != 1 || session.Hunks[0] != pending || session.Draft != "weekly task" || session.Answer != "I am an AI language model." {
		t.Fatal("answer-only turn discarded pending review", session)
	}
	session, err = m.Review(session.ID, "owner", "accept", pending.ID, session.Version)
	if err != nil || session.Draft != "one task this week" {
		t.Fatal("preserved proposal could not be accepted", err, session.Draft)
	}
}

func TestAnswerOnlySynchronousTurnPreservesPendingReview(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	session, _ := m.Create("owner", "note", "selection", "task", Configuration{})
	_, _, _, err := m.Begin(session.ID, "owner", "expand", session.Version)
	if err != nil {
		t.Fatal(err)
	}
	session, err = m.Finish(session.ID, "owner", `{"answer":"Expanded","edits":[{"before":"task","after":"realistic task"}]}`, Reply{Answer: "Expanded", Edits: []Edit{{"task", "realistic task"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	pending := session.Hunks[0]
	_, _, _, err = m.Begin(session.ID, "owner", "which model?", session.Version)
	if err != nil {
		t.Fatal(err)
	}
	session, err = m.Finish(session.ID, "owner", `{"answer":"A language model","edits":[]}`, Reply{Answer: "A language model", Edits: []Edit{}}, nil)
	if err != nil || len(session.Hunks) != 1 || session.Hunks[0] != pending || session.Draft != "task" {
		t.Fatal("lost review", err, session)
	}
}

func waitForJobWaiters(t *testing.T, m *Manager, id string, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		n := m.sessions[id].job.waiters
		m.mu.Unlock()
		if n == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("completion waiter did not register")
}

func TestJobWaitWakesOnCompletionAndReleasesCancelledWaiters(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "task", Configuration{})
	plan, err := m.PlanTurn(s.ID, "owner", "ideas", 0)
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	_, err = m.StartJob(s.ID, "owner", plan.ID, 0, func(ctx context.Context, c Configuration, messages []Message, note, session, turn string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		select {
		case <-release:
			return Reply{Answer: "Done"}, nil
		case <-ctx.Done():
			return Reply{}, ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := make(chan error, 1)
	go func() { _, err := m.WaitJob(ctx, s.ID, "owner", time.Second); cancelled <- err }()
	waitForJobWaiters(t, m, s.ID, 1)
	cancel()
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	waitForJobWaiters(t, m, s.ID, 0)
	completed := make(chan Job, 1)
	go func() {
		job, err := m.WaitJob(context.Background(), s.ID, "owner", time.Second)
		if err != nil {
			completed <- Job{Error: err.Error()}
			return
		}
		completed <- job
	}()
	waitForJobWaiters(t, m, s.ID, 1)
	close(release)
	select {
	case job := <-completed:
		if job.Status != "completed" {
			t.Fatal(job)
		}
	case <-time.After(time.Second):
		t.Fatal("completion notification was not delivered")
	}
	waitForJobWaiters(t, m, s.ID, 0)
}

func TestJobWaitCancellationAndBound(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "task", Configuration{})
	plan, _ := m.PlanTurn(s.ID, "owner", "ideas", 0)
	_, err := m.StartJob(s.ID, "owner", plan.ID, 0, func(ctx context.Context, c Configuration, messages []Message, note, session, turn string) (Reply, error) {
		if reply, ok := routeToSections(messages); ok {
			return reply, nil
		}
		<-ctx.Done()
		return Reply{}, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan Job, 2)
	for range 2 {
		go func() {
			job, err := m.WaitJob(context.Background(), s.ID, "owner", time.Second)
			if err != nil {
				results <- Job{Error: err.Error()}
			} else {
				results <- job
			}
		}()
	}
	waitForJobWaiters(t, m, s.ID, 2)
	if _, err := m.WaitJob(context.Background(), s.ID, "owner", time.Second); !errors.Is(err, ErrBusy) {
		t.Fatal("unbounded completion waiters", err)
	}
	if err := m.CancelJob(s.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if job := <-results; job.Status != "cancelled" {
			t.Fatal(job)
		}
	}
	waitForJobWaiters(t, m, s.ID, 0)
}
