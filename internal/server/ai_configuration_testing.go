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

func (a *app) handleAIConfigurationTest(w http.ResponseWriter, r *http.Request) {
	var input struct {
		OutputProfile string  `json:"output_profile"`
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		URL           string  `json:"url"`
		Key           *string `json:"key"`
		Model         string  `json:"model"`
		Revision      int64   `json:"revision"`
		ContextTokens int     `json:"context_tokens"`
		Concurrency   int     `json:"concurrency"`
	}
	if !httpx.DecodeJSON(w, r, &input, 24<<10) {
		return
	}
	c := ai.Configuration{ID: input.ID, Name: input.Name, URL: input.URL, Model: input.Model, Revision: input.Revision, OutputProfile: input.OutputProfile, ContextTokens: input.ContextTokens, Concurrency: input.Concurrency}
	if c.Name == "" {
		c.Name = "New configuration"
	}
	if c.ID != "" {
		if !notepkg.ValidID(c.ID) {
			aiError(w, errors.New("invalid configuration ID"))
			return
		}
		old, err := store.AIConfiguration(a.db, c.ID)
		if err != nil || old.Revision != c.Revision {
			aiError(w, errors.New("configuration changed; reload it before testing"))
			return
		}
		c.Key = old.Key
	}
	if input.Key != nil {
		c.Key = *input.Key
	}
	if err := c.Validate(); err != nil {
		aiError(w, err)
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
	if !aiDeadline(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ai.Timeout)
	defer cancel()
	stop := context.AfterFunc(m.Context, cancel)
	defer stop()
	c = m.Provider.WithCapabilities(ctx, c, true)
	if c.ThinkingControllable {
		off := false
		c.Thinking = &off
	}
	id := ai.ID()
	attribution := c
	if attribution.ID == "" {
		attribution.ID = "draft_" + id
	}
	if store.StartAIUsage(a.db, id, attribution, "", "", "", "test") != nil {
		aiError(w, errors.New("could not record usage; no request was sent"))
		return
	}
	started := time.Now()
	reply, _, usage, callErr := m.Provider.Complete(ctx, c, []ai.Message{{Role: "system", Content: ai.ConfigurationTestPrompt}, {Role: "user", Content: "Run the configuration test."}}, ai.ConfigurationTestMaxTokens)
	if callErr == nil && (len(reply.Changes) != 0 || len(reply.Edits) != 0 || reply.Replacement != nil) {
		callErr = errors.New("model returned edits for a prompt-only test")
	}
	callErr = aiCallError(ctx, callErr)
	outcome := aiCallOutcome(callErr)
	if store.FinishAIUsage(a.db, id, outcome, time.Since(started), usage) != nil {
		aiError(w, errors.New("could not finish usage accounting"))
		return
	}
	if callErr != nil {
		aiError(w, callErr)
		return
	}
	// Zero tells the client the provider reported no window, so it prefills the default.
	reported := m.Provider.RefreshCapacity(ctx, c)
	httpx.WriteJSON(w, map[string]any{"ok": true, "thinking_controllable": c.ThinkingControllable, "test_token": m.TestToken(aiOwner(r), c, id), "reported_context_tokens": reported, "default_context_tokens": ai.DefaultContextTokens})
}
