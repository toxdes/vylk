package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"vylk/internal/ai"
	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/store"
)

func (a *app) refreshAIEnabled() {
	a.aiMu.Lock()
	defer a.aiMu.Unlock()
	p, err := store.GetPrefs(a.db)
	if err != nil || !p.AIEnabled {
		if a.ai != nil {
			a.ai.Stop()
			a.ai = nil
		}
	}
}
func (a *app) aiManager() (*ai.Manager, error) {
	a.aiMu.Lock()
	defer a.aiMu.Unlock()
	p, err := store.GetPrefs(a.db)
	if err != nil || !p.AIEnabled {
		return nil, errors.New("AI is disabled")
	}
	if a.ai == nil {
		a.ai = ai.NewManager(a.aiConcurrency)
	}
	return a.ai, nil
}
func aiError(w http.ResponseWriter, err error) {
	httpx.WriteAPIError(w, http.StatusBadRequest, "ai_request_failed", err.Error())
}
func (a *app) aiEnabled(next http.HandlerFunc) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request) {
		p, err := store.GetPrefs(a.db)
		if err != nil {
			httpx.WriteAPIError(w, 500, "ai_unavailable", "could not read AI settings")
			return
		}
		if !p.AIEnabled {
			httpx.WriteAPIError(w, 403, "ai_disabled", "AI is disabled")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		next(w, r)
	})
}
func aiOwner(r *http.Request) string { c, _ := r.Cookie("session"); return ai.Owner(c.Value) }

func (a *app) handleAIConfigurations(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		all, err := store.AIConfigurations(a.db)
		if err != nil {
			httpx.WriteAPIError(w, 500, "ai_storage_failed", "could not load AI configurations")
			return
		}
		httpx.WriteJSON(w, all)
		return
	}
	var input struct {
		OutputProfile string  `json:"output_profile"`
		Name          string  `json:"name"`
		URL           string  `json:"url"`
		Key           *string `json:"key"`
		Model         string  `json:"model"`
		Revision      int64   `json:"revision"`
		TestToken     string  `json:"test_token"`
		ContextTokens int     `json:"context_tokens"`
		Concurrency   int     `json:"concurrency"`
	}
	if !httpx.DecodeJSON(w, r, &input, 24<<10) {
		return
	}
	c := ai.Configuration{ID: r.PathValue("id"), Name: input.Name, URL: input.URL, Model: input.Model, Revision: input.Revision, OutputProfile: input.OutputProfile, ContextTokens: input.ContextTokens, Concurrency: input.Concurrency}
	create := r.Method == http.MethodPost
	if !create && !notepkg.ValidID(c.ID) {
		aiError(w, errors.New("invalid configuration ID"))
		return
	}
	if create {
		c.ID = ai.ID()
	} else {
		old, err := store.AIConfiguration(a.db, c.ID)
		if err != nil {
			aiError(w, errors.New("configuration not found"))
			return
		}
		c.Key = old.Key
		c.Checked = old.Checked && old.URL == c.URL && old.Model == c.Model && old.OutputProfile == c.OutputProfile && (input.Key == nil || *input.Key == old.Key)
	}
	if input.Key != nil {
		c.Key = *input.Key
	}
	if err := c.Validate(); err != nil {
		aiError(w, err)
		return
	}
	var testedUsage []string
	if input.TestToken != "" {
		m, err := a.aiManager()
		if err != nil {
			aiError(w, err)
			return
		}
		binding := c
		if create {
			binding.ID = ""
		}
		id, err := m.VerifyTestToken(aiOwner(r), binding, input.TestToken)
		if err != nil {
			aiError(w, err)
			return
		}
		testedUsage = []string{id}
		c.Checked = true
	}
	a.aiMu.Lock()
	err := store.SaveAIConfiguration(a.db, c, create, testedUsage...)
	if err == nil && a.ai != nil {
		a.ai.CloseConfiguration(c.ID)
	}
	a.aiMu.Unlock()
	if err != nil {
		aiError(w, errors.New("configuration could not be saved; reload before editing"))
		return
	}
	a.publishChange("ai")
	c, err = store.AIConfiguration(a.db, c.ID)
	if err != nil {
		aiError(w, errors.New("could not reload configuration"))
		return
	}
	httpx.WriteJSON(w, c)
}
func (a *app) handleAIConfigurationAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !notepkg.ValidID(id) {
		aiError(w, errors.New("invalid configuration ID"))
		return
	}
	action := r.PathValue("action")
	if r.Method == http.MethodDelete {
		a.aiMu.Lock()
		err := store.DeleteAIConfiguration(a.db, id)
		if a.ai != nil {
			a.ai.CloseConfiguration(id)
		}
		a.aiMu.Unlock()
		if err != nil {
			aiError(w, errors.New("could not delete configuration"))
			return
		}
		a.publishChange("ai")
		w.WriteHeader(204)
		return
	}
	if action == "default" {
		a.aiMu.Lock()
		err := store.DefaultAIConfiguration(a.db, id)
		a.aiMu.Unlock()
		if err != nil {
			aiError(w, errors.New("check this configuration before choosing it as default"))
			return
		}
		a.publishChange("ai")
		w.WriteHeader(204)
		return
	}
	if action != "check" {
		http.NotFound(w, r)
		return
	}
	m, err := a.aiManager()
	if err != nil {
		aiError(w, err)
		return
	}
	release, err := m.CheckSlot()
	if err != nil {
		aiError(w, err)
		return
	}
	defer release()
	c, err := store.AIConfiguration(a.db, id)
	if err != nil {
		aiError(w, errors.New("configuration not found"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ai.Timeout)
	defer cancel()
	stop := context.AfterFunc(m.Context, cancel)
	defer stop()
	if !aiDeadline(w) {
		return
	}
	usageID := ai.ID()
	if store.StartAIUsage(a.db, usageID, c, "", "", "", "check") != nil {
		aiError(w, errors.New("could not record usage; no request was sent"))
		return
	}
	started := time.Now()
	c = m.Provider.WithCapabilities(ctx, c, true)
	if c.ThinkingControllable {
		off := false
		c.Thinking = &off
	}
	reply, _, usage, callErr := m.Provider.Complete(ctx, c, []ai.Message{{Role: "system", Content: ai.ConfigurationTestPrompt}, {Role: "user", Content: "Run the configuration test."}}, ai.ConfigurationTestMaxTokens)
	callErr = aiCallError(ctx, callErr)
	if callErr == nil && (len(reply.Changes) != 0 || len(reply.Edits) != 0 || reply.Replacement != nil) {
		callErr = errors.New("model returned edits for a prompt-only check")
	}
	a.aiMu.Lock()
	if callErr == nil && m.Context.Err() != nil {
		callErr = ai.ErrCancelled
	}
	if callErr == nil {
		callErr = store.CheckAIConfiguration(a.db, c)
	}
	if callErr != nil && ctx.Err() == nil {
		_ = store.UncheckAIConfiguration(a.db, c)
		m.CloseConfiguration(c.ID)
	}
	a.aiMu.Unlock()
	outcome := aiCallOutcome(callErr)
	if store.FinishAIUsage(a.db, usageID, outcome, time.Since(started), usage) != nil {
		aiError(w, errors.New("could not finish usage accounting"))
		return
	}
	if callErr != nil {
		a.publishChange("ai")
		aiError(w, callErr)
		return
	}
	a.publishChange("ai")
	m.Provider.RefreshCapacity(ctx, c)
	httpx.WriteJSON(w, map[string]bool{"ok": true})
}
func aiDeadline(w http.ResponseWriter) bool {
	err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(ai.Timeout + 10*time.Second))
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		httpx.WriteAPIError(w, 500, "ai_deadline_failed", "could not configure AI request deadline")
		return false
	}
	return true
}

func aiCallError(ctx context.Context, err error) error {
	switch ctx.Err() {
	case context.DeadlineExceeded:
		return ai.ErrTimeout
	case context.Canceled:
		return ai.ErrCancelled
	default:
		return err
	}
}

func aiCallOutcome(err error) string {
	switch {
	case err == nil:
		return "success"
	case errors.Is(err, ai.ErrTimeout):
		return "timeout"
	case errors.Is(err, ai.ErrCancelled):
		return "cancelled"
	default:
		return "failed"
	}
}
func (a *app) handleAISessionCreate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		NoteID string `json:"note_id"`
		Scope  string `json:"scope"`
		Text   string `json:"text"`
	}
	if !httpx.DecodeJSON(w, r, &input, (ai.MaxSnapshot*6)+(4<<10)) {
		return
	}
	if !notepkg.ValidID(input.NoteID) {
		aiError(w, errors.New("invalid note ID"))
		return
	}
	m, err := a.aiManager()
	if err != nil {
		aiError(w, err)
		return
	}
	all, err := store.AIConfigurations(a.db)
	if err != nil {
		aiError(w, errors.New("could not load configurations"))
		return
	}
	for _, c := range all {
		if c.Default && c.Checked {
			c = m.Provider.WithCapabilities(r.Context(), c, false)
			a.aiMu.Lock()
			defer a.aiMu.Unlock()
			current, lookupErr := store.AIConfiguration(a.db, c.ID)
			if lookupErr != nil || current.Revision != c.Revision || !current.Checked || !current.Default {
				aiError(w, errors.New("AI configuration changed; reopen AI"))
				return
			}
			s, err := m.Create(aiOwner(r), input.NoteID, input.Scope, input.Text, c)
			if err != nil {
				aiError(w, err)
				return
			}
			httpx.WriteJSON(w, ai.BrowserView(s))
			return
		}
	}
	aiError(w, errors.New("check a configuration and set it as default in AI preferences"))
}
func (a *app) handleAISession(w http.ResponseWriter, r *http.Request) {
	m, err := a.aiManager()
	if err != nil {
		aiError(w, err)
		return
	}
	id, owner := r.PathValue("id"), aiOwner(r)
	if !notepkg.ValidID(id) {
		aiError(w, errors.New("invalid session ID"))
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Get("job") != "" {
		var status ai.Job
		var err error
		if r.URL.Query().Get("wait") == "1" {
			status, err = m.WaitJob(r.Context(), id, owner, 25*time.Second)
		} else {
			status, err = m.Job(id, owner)
		}
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, status)
		return
	}
	if r.Method == http.MethodGet {
		s, err := m.Metadata(id, owner)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, ai.BrowserView(s))
		return
	}
	if r.Method == http.MethodDelete {
		m.Close(id, owner)
		w.WriteHeader(204)
		return
	}
	var input struct {
		Prompt          string `json:"prompt"`
		Action          string `json:"action"`
		HunkID          string `json:"hunk_id"`
		Version         int    `json:"version"`
		PlanID          string `json:"plan_id"`
		ConfigurationID string `json:"configuration_id"`
		Scope           string `json:"scope"`
		Text            string `json:"text"`
		Thinking        bool   `json:"thinking"`
		Whole           bool   `json:"whole_context"`
	}
	limit := int64(100 << 10)
	if r.PathValue("action") == "context" || r.PathValue("action") == "rebase" {
		limit = (ai.MaxSnapshot * 6) + (4 << 10)
	}
	if !httpx.DecodeJSON(w, r, &input, limit) {
		return
	}
	switch r.PathValue("action") {
	case "context":
		s, err := m.SetContext(id, owner, input.Version, input.Scope, input.Text)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, ai.BrowserView(s))
		return
	case "rebase":
		s, err := m.RebaseContext(id, owner, input.Version, input.Text)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, ai.BrowserView(s))
		return
	case "configuration":
		c, err := store.AIConfiguration(a.db, input.ConfigurationID)
		if err != nil || !c.Checked {
			aiError(w, errors.New("check this provider in AI preferences before using it"))
			return
		}
		c = m.Provider.WithCapabilities(r.Context(), c, false)
		a.aiMu.Lock()
		defer a.aiMu.Unlock()
		current, err := store.AIConfiguration(a.db, c.ID)
		if err != nil || !current.Checked || current.Revision != c.Revision {
			aiError(w, errors.New("AI configuration changed; select the provider again"))
			return
		}
		s, err := m.SetConfiguration(id, owner, input.Version, c)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, ai.BrowserView(s))
		return
	case "plan":
		plan, err := m.PlanTurn(id, owner, input.Prompt, input.Version, input.Thinking, input.Whole)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, plan)
		return
	case "start":
		job, err := m.StartJob(id, owner, input.PlanID, input.Version, a.aiSectionCall)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSONStatus(w, http.StatusAccepted, job)
		return
	case "cancel":
		if err := m.CancelJob(id, owner); err != nil {
			aiError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.PathValue("action") == "review" {
		s, err := m.Review(id, owner, input.Action, input.HunkID, input.Version)
		if err != nil {
			aiError(w, err)
			return
		}
		httpx.WriteJSON(w, ai.BrowserView(s))
		return
	}
	if r.PathValue("action") != "turn" {
		http.NotFound(w, r)
		return
	}
	if !aiDeadline(w) {
		return
	}
	release, err := m.CheckSlot()
	if err != nil {
		aiError(w, err)
		return
	}
	defer release()
	c, messages, sessionCtx, err := m.Begin(id, owner, input.Prompt, input.Version, input.Thinking, input.Whole)
	if err != nil {
		aiError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ai.Timeout)
	defer cancel()
	stop := context.AfterFunc(sessionCtx, cancel)
	defer stop()
	meta, _ := m.Metadata(id, owner)
	turnID := ai.ID()
	reply, callErr := m.CompleteWithFeedback(ctx, c, messages, meta.NoteID, id, turnID, func(ctx context.Context, c ai.Configuration, messages []ai.Message, noteID, sessionID, turnID string) (ai.Reply, error) {
		return a.aiRecordedCall(ctx, c, messages, noteID, sessionID, turnID, "turn")
	}, func(reply ai.Reply) error { return m.ValidatePendingReply(id, owner, reply) })
	s, finishErr := m.Finish(id, owner, reply.RawResponse(), reply, aiCallError(ctx, callErr))
	if finishErr != nil {
		aiError(w, finishErr)
		return
	}
	httpx.WriteJSON(w, ai.BrowserView(s))
}
