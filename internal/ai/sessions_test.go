package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExactEditsRejectUnsafeProposals(t *testing.T) {
	for _, tc := range []struct {
		name, source, scope string
		edits               []Edit
	}{
		{"duplicate", "task task", "note", []Edit{{"task", "done"}}},
		{"overlapping duplicate", "aaaa", "note", []Edit{{"aaa", "a"}}},
		{"overlap", "abc", "note", []Edit{{"ab", "a"}, {"bc", "c"}}},
		{"unshared", "", "none", []Edit{{"", "hello"}}},
		{"missing", "abc", "note", []Edit{{"missing", "x"}}},
		{"normalized line ending", "first\r\nsecond", "note", []Edit{{"first\nsecond", "replacement"}}},
		{"normalized indentation", "\t- [ ] task", "selection", []Edit{{"  - [ ] task", "replacement"}}},
		{"normalized Unicode", "Café", "note", []Edit{{"Cafe\u0301", "replacement"}}},
		{"empty anchor", "abc", "note", []Edit{{"", "x"}}},
		{"oversized", "a", "note", []Edit{{"a", strings.Repeat("x", MaxContext+1)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ValidateEdits(tc.source, tc.scope, tc.edits); err == nil {
				t.Fatal("accepted unsafe edit")
			}
		})
	}
	if _, err := ValidateEdits("", "selection", []Edit{{"", "insert"}}); err != nil {
		t.Fatal(err)
	}
}

func TestFailedTurnsDoNotPolluteTheNextConversation(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "selection", "task", Configuration{})
	_, _, _, err := m.Begin(s.ID, "owner", "failed instruction", 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = m.Finish(s.ID, "owner", "", Reply{}, ErrTimeout)
	_, messages, _, err := m.Begin(s.ID, "owner", "new instruction", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || strings.Contains(messages[1].Content, "failed instruction") {
		t.Fatal("failed attempt became conversation history", messages)
	}
}
func TestStagedDraftRefinementUndoAndFinalization(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, err := m.Create("owner", "note", "selection", "first\nsecond", Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, err = m.Begin(s.ID, "owner", "expand", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.Finish(s.ID, "owner", `{"answer":"Done","edits":[]}`, Reply{Answer: "Done", Edits: []Edit{{"first", "first expanded"}, {"second", "second expanded"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.Draft != "first\nsecond" {
		t.Fatal("generation changed draft")
	}
	if _, err = m.Review(s.ID, "owner", "finalize", "", s.Version); err == nil {
		t.Fatal("finalized undecided hunks")
	}
	s, err = m.Review(s.ID, "owner", "accept", s.Hunks[0].ID, s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if s.Draft != "first expanded\nsecond" {
		t.Fatal(s.Draft)
	}
	_, messages, _, err := m.Begin(s.ID, "owner", "change the second item", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	var followup struct {
		Blocks  []Block `json:"blocks"`
		Request string  `json:"request"`
		Review  []Hunk  `json:"previous_review"`
	}
	if err := json.Unmarshal([]byte(messages[len(messages)-1].Content), &followup); err != nil {
		t.Fatal(err)
	}
	if sectionText(messages) != "first expanded\nsecond" || followup.Request != "change the second item" || len(followup.Review) != 2 || followup.Review[0].Decision != "accepted" || followup.Review[1].Decision != "" {
		t.Fatal("followup lost current draft or review decisions", followup)
	}
	s, err = m.Finish(s.ID, "owner", `{"answer":"Next","edits":[]}`, Reply{Answer: "Next", Edits: []Edit{{"second", "second final"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.Review(s.ID, "owner", "accept_all", "", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if s.Draft != "first expanded\nsecond final" {
		t.Fatal(s.Draft)
	}
	s, err = m.Review(s.ID, "owner", "undo", "", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if s.Draft != "first expanded\nsecond" || len(s.Hunks) != 0 {
		t.Fatal(s)
	}
	final, err := m.Review(s.ID, "owner", "finalize", "", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if final.Draft != s.Draft {
		t.Fatal("finalize changed draft")
	}
	if _, err = m.Metadata(s.ID, "other"); err == nil {
		t.Fatal("cross-owner session access")
	}
	m.Close(s.ID, "owner")
	if _, err = m.Metadata(s.ID, "owner"); err == nil {
		t.Fatal("closed session retained")
	}
}
func TestAcceptAllIsOneUndoAndBrowserOffsetsAreUTF16(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("o", "n", "note", "🙂 one\ntwo", Configuration{})
	_, _, _, _ = m.Begin(s.ID, "o", "edit", 0)
	s, err := m.Finish(s.ID, "o", "{}", Reply{Answer: "ok", Edits: []Edit{{"one", "ONE!"}, {"two", "TWO!"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	v := BrowserView(s)
	if v.Hunks[0].Start != 3 {
		t.Fatal(v.Hunks)
	}
	s, err = m.Review(s.ID, "o", "accept_all", "", s.Version)
	if err != nil {
		t.Fatal(err)
	}
	if s.Draft != "🙂 ONE!\nTWO!" {
		t.Fatal(s.Draft)
	}
	s, err = m.Review(s.ID, "o", "undo", "", s.Version)
	if err != nil || s.Draft != "🙂 one\ntwo" {
		t.Fatal(s.Draft, err)
	}
}
func TestManagerBoundsAndStop(t *testing.T) {
	m := NewManager()
	for range 4 {
		if _, err := m.Create("o", "n", "none", "", Configuration{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Create("o", "n", "none", "", Configuration{}); err == nil {
		t.Fatal("session cap not enforced")
	}
	m.Stop()
	if _, err := m.Create("o", "n", "none", "", Configuration{}); err == nil {
		t.Fatal("stopped manager accepted session")
	}
}
func TestProviderForwardsModelAndDoesNotLeakErrorsOrFollowRedirects(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing key")
		}
		var input struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Model != "openrouter/free" {
			t.Error(input.Model)
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}`)
	}))
	defer server.Close()
	p := NewProvider()
	defer p.Close()
	r, _, u, err := p.Complete(context.Background(), Configuration{URL: server.URL, Key: "secret", Model: "openrouter/free"}, []Message{{"user", "hello"}}, 128)
	if err != nil || r.Answer != "Ready" || *u.Total != 10 || calls != 1 {
		t.Fatal(r, u, err, calls)
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, server.URL, http.StatusFound) }))
	defer redirect.Close()
	_, _, _, err = p.Complete(context.Background(), Configuration{URL: redirect.URL, Key: "secret", Model: "openrouter/free"}, nil, 128)
	if err == nil || strings.Contains(err.Error(), "secret") || calls != 1 {
		t.Fatal("redirect followed or key exposed", err, calls)
	}
}
func BenchmarkValidateLargeScopedEdits(b *testing.B) {
	source := strings.Repeat("unchanged line\n", 17000) + "unique task"
	for b.Loop() {
		if _, err := ValidateEdits(source, "note", []Edit{{"unique task", "expanded task"}}); err != nil {
			b.Fatal(err)
		}
	}
}

func TestSessionExpiryAndConversationLimits(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("o", "n", "none", "", Configuration{})
	m.mu.Lock()
	internal := m.sessions[s.ID]
	internal.turns = 20
	m.mu.Unlock()
	if _, _, _, err := m.Begin(s.ID, "o", "hello", 0); err == nil {
		t.Fatal("turn cap not enforced")
	}
	m.mu.Lock()
	internal.turns = 0
	internal.history = []Message{{Role: "user", Content: strings.Repeat("x", MaxHistory)}}
	m.mu.Unlock()
	if _, _, _, err := m.Begin(s.ID, "o", "hello", 0); err == nil {
		t.Fatal("history cap not enforced")
	}
	internal.timer.Reset(0)
	select {
	case <-internal.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("expired session retained")
	}
	if _, err := m.Metadata(s.ID, "o"); err == nil {
		t.Fatal("expired session still accessible")
	}
}

func TestPartialAcceptanceCannotExceedContextBudget(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	original := strings.Repeat("x", MaxSnapshot-5) + "ab\nbc"
	s, _ := m.Create("o", "n", "note", original, Configuration{})
	hunks, err := ValidateEdits(original, "note", []Edit{{"xxxxxxxxab", "a"}, {"bc", "longer"}})
	if err != nil {
		t.Fatal(err)
	}
	m.sessions[s.ID].Hunks = hunks
	s = m.sessions[s.ID].view()
	if _, err = m.Review(s.ID, "o", "accept", s.Hunks[1].ID, s.Version); err == nil {
		t.Fatal("partial acceptance exceeded context limit")
	}
	s, err = m.Review(s.ID, "o", "accept_all", "", s.Version)
	if err != nil || s.Draft != strings.Repeat("x", MaxSnapshot-13)+"a\nlonger" {
		t.Fatal(s.Draft, err)
	}
}
