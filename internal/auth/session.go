package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"time"
)

const SessionLifetime = 180 * 24 * time.Hour
const SessionRenewalInterval = 7 * 24 * time.Hour
const SessionRenewalThreshold = SessionLifetime - SessionRenewalInterval

type SessionStore struct {
	db *sql.DB
}

func NewSessionStore(db *sql.DB) *SessionStore {
	return &SessionStore{db: db}
}

func SessionTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *SessionStore) Create() (string, error) {
	return s.CreateDevice("", "Unknown browser")
}

func (s *SessionStore) CreateDeviceTx(tx *sql.Tx, deviceID, name string) (string, error) {
	return createSession(tx, deviceID, name)
}

type sessionWriter interface {
	Exec(string, ...any) (sql.Result, error)
}

func (s *SessionStore) CreateDevice(deviceID, name string) (string, error) {
	return createSession(s.db, deviceID, name)
}

func createSession(writer sessionWriter, deviceID, name string) (string, error) {
	token, err := newSessionToken()
	if err != nil {
		return "", err
	}
	if deviceID == "" {
		deviceID, err = newSessionToken()
		if err != nil {
			return "", err
		}
	}
	now := time.Now().UTC()
	_, err = writer.Exec(`INSERT INTO sessions
		(token_hash, expires_at, device_id, device_name, created_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?)`, SessionTokenHash(token), now.Add(SessionLifetime).Format(time.RFC3339),
		deviceID, name, now.Format(time.RFC3339), now.Format(time.RFC3339))
	if err != nil {
		return "", err
	}
	return token, nil
}

func newSessionToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *SessionStore) Valid(token string) bool {
	valid, _ := s.ValidAndRenew(token)
	return valid
}

func (s *SessionStore) ValidAndRenew(token string) (bool, bool) {
	var expiry string
	if err := s.db.QueryRow("SELECT expires_at FROM sessions WHERE token_hash = ? AND revoked_at = ''", SessionTokenHash(token)).Scan(&expiry); err != nil {
		return false, false
	}
	expiresAt, err := time.Parse(time.RFC3339, expiry)
	now := time.Now().UTC()
	if err != nil || !now.Before(expiresAt) {
		_ = s.revoke("token_hash = ?", []any{SessionTokenHash(token)}, "expired")
		return false, false
	}
	// Activity is approximate; avoid a write for every request and SSE heartbeat.
	_, _ = s.db.Exec(`UPDATE sessions SET last_seen_at = ?
		WHERE token_hash = ? AND revoked_at = '' AND last_seen_at < ?`,
		now.Format(time.RFC3339), SessionTokenHash(token), now.Add(-5*time.Minute).Format(time.RFC3339))
	if expiresAt.Sub(now) >= SessionRenewalThreshold {
		return true, false
	}

	nextExpiry := now.Add(SessionLifetime).Format(time.RFC3339)
	result, err := s.db.Exec(
		"UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at = ? AND revoked_at = ''",
		nextExpiry, SessionTokenHash(token), expiry,
	)
	if err != nil {
		// A transient renewal failure must not invalidate an existing session.
		return true, false
	}
	rows, err := result.RowsAffected()
	return true, err == nil && rows > 0
}

func (s *SessionStore) Remove(token string) {
	_ = s.revoke("token_hash = ?", []any{SessionTokenHash(token)}, "signed_out")
}

func (s *SessionStore) Cleanup() {
	now := time.Now().UTC()
	_ = s.revoke("expires_at <= ?", []any{now.Format(time.RFC3339)}, "expired")
	cutoff := now.Add(-90 * 24 * time.Hour).Format(time.RFC3339)
	_, _ = s.db.Exec("DELETE FROM sessions WHERE revoked_at <> '' AND revoked_at < ?", cutoff)
	_, _ = s.db.Exec("DELETE FROM session_events WHERE occurred_at < ?", cutoff)
}

func (s *SessionStore) CleanupLoop() {
	for {
		time.Sleep(10 * time.Minute)
		s.Cleanup()
	}
}
