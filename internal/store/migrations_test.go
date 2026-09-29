package store

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestInitDBAdoptsPreMergeVaultSchema(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO vault_config
		(id, mode, vault_id, kdf_salt, kdf_memory_kib, kdf_iterations,
		auth_hash, recovery_hash, wrapped_key, wrapped_recovery_key, epoch)
		VALUES (1, 'encrypted', 'old-vault', 'salt', 19456, 2,
		x'0102', x'0304', 'wrapped', 'recovery', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO vault_notes
		(id, summary, filename, created_at, updated_at, revision, epoch)
		VALUES ('old-note', 'encrypted summary', '.vylk-vault/epoch-1/old-note.md.enc',
		'2026-01-01', '2026-01-01', 3, 1)`); err != nil {
		t.Fatal(err)
	}
	// Before the branch was rebased, v18 owned the vault schema, not instance metadata.
	if _, err := db.Exec(`DROP TABLE instance_metadata; DELETE FROM schema_migrations WHERE version = 19`); err != nil {
		t.Fatal(err)
	}
	if err := InitDB(db); err != nil {
		t.Fatalf("upgrade pre-merge v18 database: %v", err)
	}
	if id, err := InstanceID(db); err != nil || id == "" {
		t.Fatalf("instance ID = %q, %v", id, err)
	}
	config, err := GetVaultConfig(db)
	if err != nil || config == nil || config.VaultID != "old-vault" || config.Mode != VaultReady {
		t.Fatalf("vault configuration changed: %#v, %v", config, err)
	}
	var summary string
	var revision int
	if err := db.QueryRow("SELECT summary, revision FROM vault_notes WHERE id = 'old-note'").Scan(&summary, &revision); err != nil {
		t.Fatal(err)
	}
	if summary != "encrypted summary" || revision != 3 {
		t.Fatalf("vault note changed: summary %q, revision %d", summary, revision)
	}
	if err := InitDB(db); err != nil {
		t.Fatalf("repeat initialization: %v", err)
	}
}

func TestInitDBRejectsIncompletePreMergeVaultSchema(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE vault_staged_notes; DELETE FROM schema_migrations WHERE version = 19`); err != nil {
		t.Fatal(err)
	}
	if err := InitDB(db); err == nil || !strings.Contains(err.Error(), "incomplete vault schema") {
		t.Fatalf("incomplete schema migration error = %v", err)
	}
	var migrated int
	if err := db.QueryRow("SELECT count(*) FROM schema_migrations WHERE version = 19").Scan(&migrated); err != nil || migrated != 0 {
		t.Fatalf("v19 recorded despite incomplete schema: %d, %v", migrated, err)
	}
}

func TestInitDBRejectsIncompatiblePreMergeVaultSchema(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE vault_file_operations;
		CREATE TABLE vault_file_operations (id TEXT PRIMARY KEY);
		DELETE FROM schema_migrations WHERE version = 19`); err != nil {
		t.Fatal(err)
	}
	if err := InitDB(db); err == nil || !strings.Contains(err.Error(), "incompatible vault schema") {
		t.Fatalf("incompatible schema migration error = %v", err)
	}
}
