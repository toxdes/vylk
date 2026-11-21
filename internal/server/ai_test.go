package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vylk/internal/ai"
	"vylk/internal/auth"
	"vylk/internal/store"
	"vylk/internal/web"
)

func TestAIRequestTimeoutAndCancellationHaveDistinctOutcomes(t *testing.T) {
	deadline, stopDeadline := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stopDeadline()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		name    string
		ctx     context.Context
		callErr error
		wantErr error
		outcome string
	}{
		{"deadline", deadline, nil, ai.ErrTimeout, "timeout"},
		{"cancelled", cancelled, nil, ai.ErrCancelled, "cancelled"},
		{"transport deadline", context.Background(), ai.ErrTimeout, ai.ErrTimeout, "timeout"},
		{"success", context.Background(), nil, nil, "success"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := aiCallError(tc.ctx, tc.callErr)
			if !errors.Is(err, tc.wantErr) || aiCallOutcome(err) != tc.outcome {
				t.Fatal("incorrect error/outcome", err, aiCallOutcome(err))
			}
		})
	}
}

func TestAIHTTPPrivacyUsageAndHardDisable(t *testing.T) {
	db, err := store.OpenDB(filepath.Join(t.TempDir(), "ai.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = store.InitDB(db); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, sessions: auth.NewSessionStore(db), notesDir: t.TempDir()}
	token, err := a.sessions.CreateDevice("", "AI test")
	if err != nil {
		t.Fatal(err)
	}
	assets, err := web.New(web.DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(a, assets, 0)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: "session", Value: token})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/api/ai/configurations", ""); w.Code != 403 || a.ai != nil {
		t.Fatal("disabled AI initialized", w.Code)
	}
	p, _ := store.GetPrefs(db)
	p.AIEnabled = true
	if err = store.SavePrefs(db, p, nil); err != nil {
		t.Fatal(err)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"data":[{"id":"openrouter/free","context_length":128000}]}`))
			return
		}
		var data struct {
			Model     string       `json:"model"`
			Messages  []ai.Message `json:"messages"`
			MaxTokens int          `json:"max_tokens"`
		}
		_ = json.NewDecoder(r.Body).Decode(&data)
		if data.Model != "openrouter/free" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("model/key not forwarded")
		}
		content := `{"answer":"Ready","changes":[]}`
		if strings.Contains(data.Messages[len(data.Messages)-1].Content, "expand task") {
			if data.MaxTokens != 0 {
				t.Error("normal generation did not leave its token limit to the provider")
			}
			if strings.Contains(data.Messages[len(data.Messages)-1].Content, "unshared") {
				t.Error("unshared content leaked")
			}
			content = `{"answer":"Expanded","changes":[{"id":"b0_0","before":"task","after":"task expanded"}]}`
		} else if len(data.Messages) != 2 || data.Messages[0].Role != "system" || data.Messages[0].Content != ai.ConfigurationTestPrompt || data.MaxTokens != 2048 {
			t.Error("configuration check did not use the minimal prompt and bounded test budget")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
	}))
	defer provider.Close()
	body, _ := json.Marshal(map[string]string{"name": "<script>SELECT</script>", "url": provider.URL, "key": "test-secret", "model": "openrouter/free"})
	w := request("POST", "/api/ai/configurations", string(body))
	if w.Code != 200 || strings.Contains(w.Body.String(), "test-secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	var c ai.Configuration
	_ = json.Unmarshal(w.Body.Bytes(), &c)
	w = request("POST", "/api/ai/configurations/"+c.ID+"/check", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = request("GET", "/api/ai/configurations", "")
	if strings.Contains(w.Body.String(), "test-secret") || !strings.Contains(w.Body.String(), `"is_default":true`) {
		t.Fatal(w.Body.String())
	}
	w = request("POST", "/api/ai/sessions", `{"note_id":"local-unsynced-note","scope":"selection","text":"task"}`)
	var session ai.Session
	if err = json.Unmarshal(w.Body.Bytes(), &session); err != nil || w.Code != 200 {
		t.Fatal(w.Body.String(), err)
	}
	w = request("POST", "/api/ai/sessions/"+session.ID+"/turn", `{"prompt":"expand task","version":0}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &session)
	if session.Draft != "task" {
		t.Fatal("note/draft changed before acceptance")
	}
	var count, total int
	if err = db.QueryRow(`SELECT COUNT(*),SUM(total_tokens) FROM ai_usage`).Scan(&count, &total); err != nil || count != 2 || total != 30 {
		t.Fatal(count, total, err)
	}
	testBody, _ := json.Marshal(map[string]string{"url": provider.URL, "key": "test-secret", "model": "openrouter/free"})
	w = request("POST", "/api/ai/configurations/test", string(testBody))
	if w.Code != 200 || strings.Contains(w.Body.String(), "test-secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	var tested struct {
		Token string `json:"test_token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &tested)
	if tested.Token == "" {
		t.Fatal("test did not return a receipt")
	}
	var configurations int
	if err = db.QueryRow(`SELECT COUNT(*) FROM ai_configurations`).Scan(&configurations); err != nil || configurations != 1 {
		t.Fatal("Test persisted an unsaved configuration", configurations, err)
	}
	draft := map[string]string{"name": "New tested provider", "url": provider.URL, "key": "test-secret", "model": "changed-model", "test_token": tested.Token}
	testBody, _ = json.Marshal(draft)
	w = request("POST", "/api/ai/configurations", string(testBody))
	if w.Code != 400 {
		t.Fatal("accepted test for different credentials", w.Code)
	}
	draft["model"] = "openrouter/free"
	testBody, _ = json.Marshal(draft)
	w = request("POST", "/api/ai/configurations", string(testBody))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"checked":true`) {
		t.Fatal("could not save verified configuration", w.Code, w.Body.String())
	}
	w = request("POST", "/api/ai/configurations", string(testBody))
	if w.Code != 400 {
		t.Fatal("reused a successful test receipt", w.Code)
	}
	w = request("POST", "/api/ai/sessions/"+session.ID+"/review", `{"action":"accept_all","version":1}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	// Preference synchronization must trigger the same teardown as a direct update.
	p, _ = store.GetPrefs(db)
	p.AIEnabled = false
	body, _ = json.Marshal(map[string]any{"device_id": "ai-pref-device", "operations": []any{map[string]any{"client_sequence": 1, "op_id": "disable-ai", "type": "prefs.save", "base_revision": p.Revision, "prefs": p}}})
	w = request("POST", "/api/sync/push", string(body))
	if w.Code != 200 || strings.Contains(w.Body.String(), `"status":"rejected"`) {
		t.Fatal(w.Body.String())
	}
	if a.ai != nil {
		t.Fatal("AI manager retained after disabling")
	}
	w = request("POST", "/api/ai/sessions/"+session.ID+"/review", `{"action":"finalize","version":2}`)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	if _, err = store.AIConfiguration(db, c.ID); err != nil {
		t.Fatal("disable deleted configuration")
	}
}
