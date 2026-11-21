package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vylk/internal/ai"
	"vylk/internal/auth"
	"vylk/internal/store"
	"vylk/internal/web"
)

func TestAIBackgroundJobUsageAndSnapshotProtocol(t *testing.T) {
	db, err := store.OpenDB(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = store.InitDB(db); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, sessions: auth.NewSessionStore(db), notesDir: t.TempDir()}
	defer func() {
		if a.ai != nil {
			a.ai.Stop()
		}
	}()
	token, err := a.sessions.CreateDevice("", "AI jobs")
	if err != nil {
		t.Fatal(err)
	}
	assets, err := web.New(web.DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(a, assets, 0)
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		r.AddCookie(&http.Cookie{Name: "session", Value: token})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	var calls atomic.Int32
	var correction atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "model", "context_length": 128000}}})
			return
		}
		var input struct {
			Messages  []ai.Message `json:"messages"`
			MaxTokens *int         `json:"max_tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if input.MaxTokens != nil {
			t.Error("normal section request capped provider output")
		}
		var context struct {
			Blocks     []ai.Block      `json:"blocks"`
			SharedText json.RawMessage `json:"shared_text"`
		}
		if err := json.Unmarshal([]byte(input.Messages[len(input.Messages)-1].Content), &context); err != nil {
			t.Error(err)
			return
		}
		// The routing request precedes sections; it is billed but not counted here.
		if context.SharedText != nil {
			reply, _ := json.Marshal(map[string]any{"answer": "", "changes": []any{}, "tools": []any{map[string]any{"name": "edit_sections", "pattern": "", "ignore_case": false, "start": 0, "end": 0}}})
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(reply)}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
			return
		}
		attempt := calls.Add(1)
		changes := []ai.BlockChange{}
		for _, block := range context.Blocks {
			if text := strings.ReplaceAll(block.Text, "He go", "He goes"); text != block.Text {
				changes = append(changes, ai.BlockChange{ID: block.ID, Before: block.Text, After: text})
			}
		}
		var feedback struct {
			Feedback *struct {
				Error string `json:"error"`
			} `json:"validation_feedback"`
		}
		_ = json.Unmarshal([]byte(input.Messages[len(input.Messages)-1].Content), &feedback)
		if feedback.Feedback != nil && feedback.Feedback.Error != "" {
			correction.Store(true)
		}
		if attempt == 1 {
			changes = []ai.BlockChange{{ID: "not-a-current-block", Before: "He go", After: "bad"}}
		}
		reply, _ := json.Marshal(map[string]any{"answer": "Corrected", "changes": changes})
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(reply)}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
	}))
	defer provider.Close()
	prefs, _ := store.GetPrefs(db)
	prefs.AIEnabled = true
	if err := store.SavePrefs(db, prefs, nil); err != nil {
		t.Fatal(err)
	}
	c := ai.Configuration{ID: ai.ID(), Name: "test", URL: provider.URL, Model: "model", Checked: true}
	if err := store.SaveAIConfiguration(db, c, true); err != nil {
		t.Fatal(err)
	}
	if err := store.DefaultAIConfiguration(db, c.ID); err != nil {
		t.Fatal(err)
	}
	w := request("POST", "/api/ai/sessions", map[string]any{"note_id": ai.ID(), "scope": "note", "text": strings.Repeat("He go home.\n\n", 4000)})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var session ai.Session
	_ = json.Unmarshal(w.Body.Bytes(), &session)
	base := "/api/ai/sessions/" + session.ID
	w = request("POST", base+"/plan", map[string]any{"prompt": "Fix grammar", "version": 0})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var plan ai.Plan
	_ = json.Unmarshal(w.Body.Bytes(), &plan)
	if calls.Load() != 0 || plan.Sections < 2 {
		t.Fatal("planning billed or did not split", calls.Load(), plan.Sections)
	}
	w = request("POST", base+"/start", map[string]any{"plan_id": plan.ID, "version": 0})
	if w.Code != 202 || !strings.Contains(w.Header().Get("Content-Type"), "application/json") {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
	var job ai.Job
	_ = json.Unmarshal(w.Body.Bytes(), &job)
	deadline := time.Now().Add(5 * time.Second)
	for job.Status == "running" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
		w = request("GET", base+"?job=1", nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		_ = json.Unmarshal(w.Body.Bytes(), &job)
	}
	if job.Status != "completed" || job.Completed != plan.Sections+1 || int(calls.Load()) != plan.Sections+1 {
		t.Fatal(job, calls.Load())
	}
	var rows, turns, total int
	if err := db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT turn_id), COALESCE(SUM(total_tokens),0) FROM ai_usage WHERE kind='section' AND outcome='success' AND session_id=?`, session.ID).Scan(&rows, &turns, &total); err != nil {
		t.Fatal(err)
	}
	if rows != plan.Sections+1 || turns != 1 || total != 30*rows {
		t.Fatal("incorrect per-call accounting", rows, turns, total)
	}
	var failed, allRows, allTokens int
	if err := db.QueryRow(`SELECT COUNT(*),COALESCE(SUM(total_tokens),0) FROM ai_usage WHERE kind='section' AND session_id=?`, session.ID).Scan(&allRows, &allTokens); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM ai_usage WHERE kind='section' AND outcome='failed' AND session_id=?`, session.ID).Scan(&failed); err != nil {
		t.Fatal(err)
	}
	if failed != 1 || allRows != plan.Sections+2 || allTokens != allRows*30 || !correction.Load() {
		t.Fatal("correction call was not separately accounted", failed, allRows, allTokens)
	}
	w = request("GET", base, nil)
	_ = json.Unmarshal(w.Body.Bytes(), &session)
	if len(session.Hunks) == 0 || session.Version != 1 {
		t.Fatal("no completed review", w.Body.String())
	}
	w = request("POST", base+"/start", map[string]any{"plan_id": plan.ID, "version": 0})
	var resumed ai.Job
	_ = json.Unmarshal(w.Body.Bytes(), &resumed)
	if w.Code != 202 || resumed.ID != job.ID || resumed.Status != "completed" {
		t.Fatal("idempotent start did not recover completed job", w.Code, resumed)
	}
}

func TestAIConcurrencyEnvironmentIsBounded(t *testing.T) {
	for _, value := range []string{"", "1", "8", "0", "9", "-1", "oops"} {
		t.Run(value, func(t *testing.T) {
			config, err := loadRuntimeConfig(nil, func(key string) string {
				if key == "VYLK_AI_CONCURRENCY" {
					return value
				}
				return ""
			}, func(string) (string, error) { return "", nil })
			valid := value == "" || value == "1" || value == "8"
			if valid && (err != nil || config.AIConcurrency < 1 || config.AIConcurrency > 8) {
				t.Fatal(config.AIConcurrency, err)
			}
			if !valid && err == nil {
				t.Fatal("invalid concurrency accepted")
			}
		})
	}
}
