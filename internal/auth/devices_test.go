package auth_test

import (
	"path/filepath"
	"testing"
	"time"

	"vylk/internal/auth"
	"vylk/internal/store"
)

func TestDeviceRevocationAndExpiry(t *testing.T) {
	db, err := store.OpenDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.InitDB(db); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessionStore(db)
	a, err := sessions.CreateDevice("device-a", "Firefox on Linux")
	if err != nil {
		t.Fatal(err)
	}
	a2, err := sessions.CreateDevice("device-a", "Firefox on Linux")
	if err != nil {
		t.Fatal(err)
	}
	b, err := sessions.CreateDevice("device-b", "Safari on iPhone")
	if err != nil {
		t.Fatal(err)
	}
	devices, err := sessions.Devices(a)
	if err != nil || len(devices) != 2 {
		t.Fatalf("devices = %#v, %v", devices, err)
	}
	for _, device := range devices {
		if device.Current != (device.ID == "device-a") {
			t.Fatalf("current device: %#v", device)
		}
	}
	if err := sessions.RevokeDevice("device-a"); err != nil {
		t.Fatal(err)
	}
	if sessions.Valid(a) || sessions.Valid(a2) || !sessions.Valid(b) {
		t.Fatal("revocation crossed device boundaries")
	}
	if err := sessions.RevokeDevice("device-a"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM session_events WHERE reason = 'device_signed_out'").Scan(&count); err != nil || count != 2 {
		t.Fatalf("duplicate revocation logged: %d, %v", count, err)
	}
	if _, err := db.Exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", time.Now().UTC().Add(-time.Hour).Format(time.RFC3339), auth.SessionTokenHash(b)); err != nil {
		t.Fatal(err)
	}
	if sessions.Valid(b) {
		t.Fatal("expired session accepted")
	}
	sessions.Cleanup()
	if err := db.QueryRow("SELECT count(*) FROM session_events WHERE reason = 'expired'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("expiry audit = %d, %v", count, err)
	}
}

func TestCredentialRevocationChoiceIsAtomic(t *testing.T) {
	db, err := store.OpenDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.InitDB(db); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessionStore(db)
	a, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	b, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RevokeCredentials(tx, a, true); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if !sessions.Valid(a) || !sessions.Valid(b) {
		t.Fatal("rolled-back revocation took effect")
	}
	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RevokeCredentials(tx, a, false); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if sessions.Valid(a) || !sessions.Valid(b) {
		t.Fatal("opt-out did not preserve other sessions")
	}
	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RevokeCredentials(tx, b, true); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if sessions.Valid(b) {
		t.Fatal("other sessions not revoked")
	}
}
