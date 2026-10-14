// Package auth owns session and login-protection behavior.
package auth

import (
	"database/sql"
	"net"
	"net/http"
	"strings"
	"time"
)

type RateLimiter struct {
	db         *sql.DB
	trustProxy bool
}

const LoginAttemptWindow = 15 * time.Minute

func NewRateLimiter(db *sql.DB, trustProxy bool) (*RateLimiter, error) {
	return &RateLimiter{db: db, trustProxy: trustProxy}, nil
}

func (rl *RateLimiter) TrustProxy() bool { return rl.trustProxy }

func (rl *RateLimiter) RealIP(r *http.Request) string {
	if !rl.trustProxy {
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			return host
		}
		return r.RemoteAddr
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i != -1 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	if real := r.Header.Get("X-Real-IP"); real != "" {
		return real
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func (rl *RateLimiter) RecordLoginAttempt(ip string, success bool) error {
	if success {
		_, err := rl.db.Exec("DELETE FROM rate_limits WHERE ip = ? AND typ = 'login'", ip)
		return err
	}
	now := time.Now().UTC()
	windowStart := now.Add(-LoginAttemptWindow).Format(time.RFC3339)
	nowText := now.Format(time.RFC3339)
	_, err := rl.db.Exec(`
		INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'login', 1, ?)
		ON CONFLICT(ip, typ) DO UPDATE SET
			count = CASE WHEN rate_limits.updated_at < ? THEN 1 ELSE rate_limits.count + 1 END,
			updated_at = ?
	`, ip, nowText, windowStart, nowText)
	return err
}

func (rl *RateLimiter) LoginRetryAfter(ip string) (int, error) {
	var count int
	var updatedAt string
	err := rl.db.QueryRow("SELECT count, updated_at FROM rate_limits WHERE ip = ? AND typ = 'login'", ip).Scan(&count, &updatedAt)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	updated, err := time.Parse(time.RFC3339, updatedAt)
	if err != nil || time.Since(updated) >= LoginAttemptWindow {
		if _, deleteErr := rl.db.Exec("DELETE FROM rate_limits WHERE ip = ? AND typ = 'login'", ip); deleteErr != nil {
			return 0, deleteErr
		}
		return 0, nil
	}
	if count < 5 {
		return 0, nil
	}
	backoffSeconds := 1 << min(count-5, 8)
	if backoffSeconds > 300 {
		backoffSeconds = 300
	}
	remaining := time.Until(updated.Add(time.Duration(backoffSeconds) * time.Second))
	if remaining <= 0 {
		return 0, nil
	}
	// Retry-After is an integer number of seconds and must not round down to a
	// time at which the request would still be rejected.
	return int((remaining + time.Second - 1) / time.Second), nil
}
