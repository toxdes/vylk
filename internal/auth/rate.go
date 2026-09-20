// Package auth owns session and login-protection behavior.
package auth

import (
	"database/sql"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type RateLimiter struct {
	db         *sql.DB
	trustProxy bool
	mu         sync.Mutex
	bans       map[string]banCacheEntry
}

type banCacheEntry struct {
	banned  bool
	expires time.Time
}

const (
	banCacheTTL        = 5 * time.Minute
	maxCachedBanIPs    = 4096
	LoginAttemptWindow = 15 * time.Minute
)

func NewRateLimiter(db *sql.DB, trustProxy bool) (*RateLimiter, error) {
	return &RateLimiter{db: db, trustProxy: trustProxy, bans: make(map[string]banCacheEntry)}, nil
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

func (rl *RateLimiter) IsBanned(ip string) (bool, error) {
	rl.mu.Lock()
	if cached, ok := rl.bans[ip]; ok && time.Now().Before(cached.expires) {
		rl.mu.Unlock()
		return cached.banned, nil
	}
	delete(rl.bans, ip)
	rl.mu.Unlock()
	return false, nil
}

func (rl *RateLimiter) cacheBan(ip string, banned bool) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if len(rl.bans) >= maxCachedBanIPs {
		now := time.Now()
		for key, entry := range rl.bans {
			if now.After(entry.expires) {
				delete(rl.bans, key)
			}
		}
		if len(rl.bans) >= maxCachedBanIPs {
			return
		}
	}
	rl.bans[ip] = banCacheEntry{banned: banned, expires: time.Now().Add(banCacheTTL)}
}

func (rl *RateLimiter) banIP(ip string) {
	rl.cacheBan(ip, true)
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
	if err != nil {
		return err
	}
	var count int
	err = rl.db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'login'", ip).Scan(&count)
	if err != nil {
		return err
	}
	if count >= 5 {
		rl.banIP(ip)
	}
	return nil
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
