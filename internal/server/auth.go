package server

import (
	"crypto/subtle"
	"database/sql"
	"net/http"
	"strconv"
	"sync"

	"vylk/internal/auth"
	"vylk/internal/event"
	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/notecrypt"
)

type app struct {
	db         *sql.DB
	instanceID string
	noteMu     sync.Mutex
	sessions   *auth.SessionStore
	password   string
	notesDir   string
	encryption *notecrypt.Config
	noteCache  *notepkg.Cache
	rl         *auth.RateLimiter
	events     *event.Broker
}

func (a *app) isSecureRequest(r *http.Request) bool {
	return r.TLS != nil || (a.rl.TrustProxy() && r.Header.Get("X-Forwarded-Proto") == "https")
}

func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session")
		if err != nil {
			httpx.WriteAPIError(w, http.StatusUnauthorized, "authentication_required", "unauthorized")
			return
		}
		valid, renewed := a.sessions.ValidAndRenew(c.Value)
		if !valid {
			httpx.WriteAPIError(w, http.StatusUnauthorized, "authentication_required", "unauthorized")
			return
		}
		if renewed {
			a.setSessionCookie(w, r, c.Value)
		}
		next(w, r)
	}
}

func (a *app) setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(auth.SessionLifetime.Seconds()),
	})
}

func (a *app) handleCheck(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, map[string]any{
		"ok":          true,
		"version":     version,
		"revision":    appRevision,
		"instance_id": a.instanceID,
	})
}

func (a *app) handleLogout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Cookie("session")
	if c != nil {
		a.sessions.Remove(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   a.isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := a.rl.RealIP(r)
	retryAfter, err := a.rl.LoginRetryAfter(ip)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "login_rate_limit_failed", "could not check login rate limit")
		return
	}
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		httpx.WriteJSONStatus(w, http.StatusTooManyRequests, map[string]any{
			"error":       "too many login attempts",
			"code":        "login_rate_limited",
			"retry_after": retryAfter,
		})
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if !httpx.DecodeJSON(w, r, &body, 16<<10) {
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Password), []byte(a.password)) != 1 {
		a.rl.RecordLoginAttempt(ip, false)
		httpx.WriteAPIError(w, http.StatusUnauthorized, "invalid_credentials", "wrong password")
		return
	}
	a.rl.RecordLoginAttempt(ip, true)
	token, err := a.sessions.Create()
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "create_session_failed", "could not create session")
		return
	}
	a.setSessionCookie(w, r, token)
	httpx.WriteJSON(w, map[string]any{
		"ok":          true,
		"version":     version,
		"revision":    appRevision,
		"instance_id": a.instanceID,
	})
}
