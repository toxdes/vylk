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
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	_, err := s.db.Exec("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)", SessionTokenHash(token), time.Now().UTC().Add(SessionLifetime).Format(time.RFC3339))
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s *SessionStore) Valid(token string) bool {
	valid, _ := s.ValidAndRenew(token)
	return valid
}

func (s *SessionStore) ValidAndRenew(token string) (bool, bool) {
	var expiry string
	if err := s.db.QueryRow("SELECT expires_at FROM sessions WHERE token_hash = ?", SessionTokenHash(token)).Scan(&expiry); err != nil {
		return false, false
	}
	expiresAt, err := time.Parse(time.RFC3339, expiry)
	now := time.Now().UTC()
	if err != nil || !now.Before(expiresAt) {
		s.Remove(token)
		return false, false
	}
	if expiresAt.Sub(now) >= SessionRenewalThreshold {
		return true, false
	}

	nextExpiry := now.Add(SessionLifetime).Format(time.RFC3339)
	result, err := s.db.Exec(
		"UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at = ?",
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
	_, _ = s.db.Exec("DELETE FROM sessions WHERE token_hash = ?", SessionTokenHash(token))
}

func (s *SessionStore) Cleanup() {
	_, _ = s.db.Exec("DELETE FROM sessions WHERE expires_at <= ?", time.Now().UTC().Format(time.RFC3339))
}

func (s *SessionStore) CleanupLoop() {
	for {
		time.Sleep(10 * time.Minute)
		s.Cleanup()
	}
}
