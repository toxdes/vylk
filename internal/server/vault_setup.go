package server

import (
	"crypto/subtle"
	"net/http"
	"strconv"

	"vylk/internal/httpx"
	"vylk/internal/store"
)

// Verification does not create a vault, session, or migration checkpoint.
func (a *app) handleVaultSetupPassword(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ip := a.rl.RealIP(r)
	retryAfter, err := a.rl.LoginRetryAfter(ip)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "login_rate_limit_failed", "could not check login rate limit")
		return
	}
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		httpx.WriteAPIError(w, http.StatusTooManyRequests, "login_rate_limited", "too many attempts; please try again later")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if !httpx.DecodeJSON(w, r, &body, 16<<10) {
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
		return
	}
	if config != nil && config.Mode != store.VaultPreparing {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_setup_unavailable", "encryption is already enabled")
		return
	}
	valid := a.password != "" && subtle.ConstantTimeCompare([]byte(body.Password), []byte(a.password)) == 1
	if err := a.rl.RecordLoginAttempt(ip, valid); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "login_rate_limit_failed", "could not record password verification")
		return
	}
	if !valid {
		httpx.WriteAPIError(w, http.StatusForbidden, "invalid_credentials", "wrong password")
		return
	}
	httpx.WriteJSON(w, map[string]bool{"ok": true})
}
