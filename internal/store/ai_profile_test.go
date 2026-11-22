package store

import (
	"path/filepath"
	"testing"
	"vylk/internal/ai"
)

func TestAIOutputProfilePersistsAndUpgradesExistingConfigurations(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "profile.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	c := ai.Configuration{ID: ai.ID(), Name: "Local", URL: "http://localhost:1234/v1", Model: "model", OutputProfile: "json_schema"}
	if err := SaveAIConfiguration(db, c, true); err != nil {
		t.Fatal(err)
	}
	saved, err := AIConfiguration(db, c.ID)
	if err != nil || saved.OutputProfile != "json_schema" {
		t.Fatal(saved, err)
	}
	if _, err := db.Exec(`ALTER TABLE ai_configurations DROP COLUMN output_profile; DELETE FROM schema_migrations WHERE version=22`); err != nil {
		t.Fatal(err)
	}
	if err := InitDB(db); err != nil {
		t.Fatal(err)
	}
	saved, err = AIConfiguration(db, c.ID)
	if err != nil || saved.OutputProfile != "" || saved.Model != c.Model {
		t.Fatal(saved, err)
	}
	saved.OutputProfile = "json_schema"
	if err := SaveAIConfiguration(db, saved, false); err != nil {
		t.Fatal(err)
	}
	saved, err = AIConfiguration(db, c.ID)
	if err != nil || saved.OutputProfile != "json_schema" {
		t.Fatal(saved, err)
	}
}
