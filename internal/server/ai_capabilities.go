package server

import (
	"net/http"
	"vylk/internal/httpx"
	"vylk/internal/store"
)

// Called only when the AI sidebar opens. Metadata is advisory and never exposes
// credentials; the session independently freezes its own capability decision.
func (a *app) handleAICapabilities(w http.ResponseWriter, r *http.Request) {
	m, err := a.aiManager()
	if err != nil {
		aiError(w, err)
		return
	}
	configurations, err := store.AIConfigurations(a.db)
	if err != nil {
		aiError(w, err)
		return
	}
	controllable := false
	provider := "your configured AI provider"
	for _, c := range configurations {
		if c.Default && c.Checked {
			provider = c.Name + " (" + c.Model + ")"
			controllable = m.Provider.DiscoverThinking(r.Context(), c, false)
			break
		}
	}
	httpx.WriteJSON(w, map[string]any{"thinking_controllable": controllable, "provider_name": provider})
}
