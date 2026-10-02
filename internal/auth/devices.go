package auth

import (
	"database/sql"
	"fmt"
	"time"
)

type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	LastSeenAt string `json:"last_seen_at"`
	Current    bool   `json:"current"`
}

func (s *SessionStore) DeviceID(token string) (string, error) {
	var id string
	err := s.db.QueryRow("SELECT device_id FROM sessions WHERE token_hash = ?", SessionTokenHash(token)).Scan(&id)
	return id, err
}

func (s *SessionStore) Devices(token string) ([]Device, error) {
	current, err := s.DeviceID(token)
	if err != nil {
		return nil, fmt.Errorf("current device: %w", err)
	}
	rows, err := s.db.Query(`SELECT device_id, device_name, MAX(last_seen_at)
		FROM sessions WHERE revoked_at = '' AND expires_at > ?
		GROUP BY device_id ORDER BY MAX(last_seen_at) DESC, device_id`, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()
	devices := []Device{}
	for rows.Next() {
		var device Device
		if err := rows.Scan(&device.ID, &device.Name, &device.LastSeenAt); err != nil {
			return nil, err
		}
		device.Current = device.ID == current
		devices = append(devices, device)
	}
	return devices, rows.Err()
}

func revokeSessions(tx *sql.Tx, condition string, args []any, reason string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	// The audit and invalidation commit together; no tokens or note data are logged.
	if _, err := tx.Exec(`INSERT INTO session_events (device_id, reason, occurred_at)
		SELECT device_id, ?, ? FROM sessions WHERE revoked_at = '' AND `+condition,
		append([]any{reason, now}, args...)...); err != nil {
		return err
	}
	_, err := tx.Exec("UPDATE sessions SET revoked_at = ? WHERE revoked_at = '' AND "+condition,
		append([]any{now}, args...)...)
	return err
}

func (s *SessionStore) revoke(condition string, args []any, reason string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := revokeSessions(tx, condition, args, reason); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SessionStore) RevokeDevice(id string) error {
	return s.revoke("device_id = ?", []any{id}, "device_signed_out")
}

// RevokeCredentials always replaces the requesting session. Other devices may
// retain their sessions when the user opts out of signing them out.
func (s *SessionStore) RevokeCredentials(tx *sql.Tx, token string, all bool) error {
	if all {
		return s.RevokeAllTx(tx, "credentials_changed")
	}
	return revokeSessions(tx, "token_hash = ?", []any{SessionTokenHash(token)}, "credentials_changed")
}

func (s *SessionStore) RevokeAllTx(tx *sql.Tx, reason string) error {
	return revokeSessions(tx, "1 = 1", nil, reason)
}
