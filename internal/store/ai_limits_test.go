package store

import (
	"path/filepath"
	"testing"

	"vylk/internal/ai"
)

func TestAIPlanningLimitsPersistAndUpgradeAsUnset(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "limits.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	c := ai.Configuration{ID: ai.ID(), Name: "Remote", URL: "https://example.com/v1", Model: "model", ContextTokens: 200000, Concurrency: 2}
	if err := SaveAIConfiguration(db, c, true); err != nil {
		t.Fatal(err)
	}
	saved, err := AIConfiguration(db, c.ID)
	if err != nil || saved.ContextTokens != 200000 || saved.Concurrency != 2 {
		t.Fatal(saved, err)
	}
	saved.ContextTokens, saved.Concurrency = 0, 0
	if err := SaveAIConfiguration(db, saved, false); err != nil {
		t.Fatal(err)
	}
	if cleared, err := AIConfiguration(db, c.ID); err != nil || cleared.ContextTokens != 0 || cleared.Concurrency != 0 {
		t.Fatal(cleared, err)
	}
	if _, err := db.Exec(`ALTER TABLE ai_configurations DROP COLUMN context_tokens; ALTER TABLE ai_configurations DROP COLUMN concurrency; DELETE FROM schema_migrations WHERE version=23`); err != nil {
		t.Fatal(err)
	}
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	if upgraded, err := AIConfiguration(db, c.ID); err != nil || upgraded.ContextTokens != 0 || upgraded.Concurrency != 0 {
		t.Fatal(upgraded, err)
	}
}
