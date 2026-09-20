package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	notepkg "vylk/internal/note"
	"vylk/internal/preference"
)

func TestRecoverFileOperationsCompletesCommittedReplacement(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: notepkg.NewCache()}
	stageName, err := notepkg.StageFile(notesDir, []byte("new body"))
	if err != nil {
		t.Fatalf("stage note: %v", err)
	}
	if _, err := db.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, created_at) VALUES (?, ?, ?, ?, ?)", "replace-op", fileOperationReplace, "note-a", stageName, "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("record file operation: %v", err)
	}
	if err := a.recoverFileOperations(); err != nil {
		t.Fatalf("recover file operation: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "note-a.md"))
	if err != nil || string(data) != "new body" {
		t.Fatalf("recovered note = %q, %v", data, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM file_operations").Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining file operations = %d, %v", count, err)
	}
}

func TestRecoverFileOperationsRejectsOldTargetWhenStageIsMissing(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "note-a.md"), []byte("old body"), 0600); err != nil {
		t.Fatalf("write old target: %v", err)
	}
	stageName, err := notepkg.StageFile(notesDir, []byte("new body"))
	if err != nil {
		t.Fatalf("stage replacement: %v", err)
	}
	if _, err := db.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, expected_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", "replace-op", fileOperationReplace, "note-a", stageName, notepkg.ContentHash([]byte("new body")), "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("record file operation: %v", err)
	}
	if err := os.Remove(filepath.Join(notesDir, stageName)); err != nil {
		t.Fatalf("remove stage: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: notepkg.NewCache()}
	if err := a.recoverFileOperations(); err != nil {
		t.Fatalf("recovery returned an unrelated failure: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "note-a.md"))
	if err != nil || string(data) != "old body" {
		t.Fatalf("target after failed recovery = %q, %v", data, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM file_operations").Scan(&count); err != nil || count != 1 {
		t.Fatalf("remaining file operations = %d, %v; want 1", count, err)
	}
	blocked, err := a.fileOperationBlocked("note-a")
	if err != nil || !blocked {
		t.Fatalf("failed recovery blocked note = %t, %v; want true", blocked, err)
	}
}

func TestRecoverFileOperationsIsolatesFailedNote(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "note-a.md"), []byte("old body"), 0600); err != nil {
		t.Fatalf("write old target: %v", err)
	}
	stageName, err := notepkg.StageFile(notesDir, []byte("unrelated new body"))
	if err != nil {
		t.Fatalf("stage unrelated replacement: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO file_operations (id, action, note_id, stage_name, expected_hash, created_at) VALUES
		('failed-op', ?, 'note-a', 'missing-stage', ?, '2026-01-01T00:00:00Z'),
		('healthy-op', ?, 'note-b', ?, ?, '2026-01-01T00:00:01Z')`, fileOperationReplace, notepkg.ContentHash([]byte("new body")), fileOperationReplace, stageName, notepkg.ContentHash([]byte("unrelated new body"))); err != nil {
		t.Fatalf("record file operations: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: notepkg.NewCache()}
	if err := a.recoverFileOperations(); err != nil {
		t.Fatalf("recover file operations: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "note-b.md"))
	if err != nil || string(data) != "unrelated new body" {
		t.Fatalf("unrelated note after recovery = %q, %v", data, err)
	}
	blocked, err := a.fileOperationBlocked("note-a")
	if err != nil || !blocked {
		t.Fatalf("failed note blocked = %t, %v; want true", blocked, err)
	}
	blocked, err = a.fileOperationBlocked("note-b")
	if err != nil || blocked {
		t.Fatalf("healthy note blocked = %t, %v; want false", blocked, err)
	}
	for range 2 {
		if err := a.recoverFileOperations(); err != nil {
			t.Fatalf("repeat recovery: %v", err)
		}
	}
	var quarantined int
	if err := db.QueryRow("SELECT quarantined FROM file_operations WHERE id = 'failed-op'").Scan(&quarantined); err != nil || quarantined != 1 {
		t.Fatalf("failed operation quarantine = %d, %v; want 1", quarantined, err)
	}
}

func TestUnreadableNoteFileIsNotReportedAsMissing(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "unreadable", "Unreadable", "unreadable.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "unreadable.md"), 0700); err != nil {
		t.Fatalf("create unreadable note path: %v", err)
	}
	a := &app{db: db, notesDir: dir, noteCache: notepkg.NewCache()}
	r := httptest.NewRequest(http.MethodGet, "/api/notes/unreadable", nil)
	r.SetPathValue("id", "unreadable")
	w := httptest.NewRecorder()
	a.handleGetNote(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("unreadable note status = %d: %s", w.Code, w.Body.String())
	}
}

func TestRecoverFileOperationsCompletesCommittedDelete(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "note-a.md"), []byte("old body"), 0600); err != nil {
		t.Fatalf("write note: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: notepkg.NewCache()}
	if _, err := db.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, created_at) VALUES (?, ?, ?, ?, ?)", "delete-op", fileOperationDelete, "note-a", "", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("record file operation: %v", err)
	}
	if err := a.recoverFileOperations(); err != nil {
		t.Fatalf("recover file operation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "note-a.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted note remains: %v", err)
	}
}

func TestMetadataSearchTracksNoteUpdatesAndDeletes(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "alpha", "Project Aurora", "alpha.md", "work,urgent"); err != nil {
		t.Fatalf("insert alpha: %v", err)
	}
	if err := upsertNote(db, "beta", "Shopping list", "beta.md", "home"); err != nil {
		t.Fatalf("insert beta: %v", err)
	}
	if _, err := db.Exec("UPDATE notes SET pinned = 1, pin_order = 7 WHERE id = ?", "alpha"); err != nil {
		t.Fatalf("pin alpha: %v", err)
	}
	results, err := searchNotes(db, "auro", 50)
	if err != nil || len(results) != 1 || results[0].ID != "alpha" || !results[0].Pinned || results[0].PinOrder != 7 {
		t.Fatalf("title search = %#v, %v", results, err)
	}
	results, err = searchNotes(db, "urgent", 50)
	if err != nil || len(results) != 1 || results[0].ID != "alpha" {
		t.Fatalf("tag search = %#v, %v", results, err)
	}
	if err := deleteNote(db, "alpha"); err != nil {
		t.Fatalf("delete alpha: %v", err)
	}
	results, err = searchNotes(db, "aurora", 50)
	if err != nil || len(results) != 0 {
		t.Fatalf("search after delete = %#v, %v", results, err)
	}
}

func TestListNotesPageUsesStableCursor(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if err := upsertNote(db, id, id, id+".md", ""); err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}
	first, err := listNotesPage(db, "", "", 2)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first.Notes) != 2 || first.NextCursor == "" {
		t.Fatalf("first page = %#v", first)
	}
	second, err := listNotesPage(db, "", first.NextCursor, 2)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second.Notes) != 1 || second.NextCursor != "" {
		t.Fatalf("second page = %#v", second)
	}
	if _, _, err := decodeNoteCursor("not-a-cursor"); !errors.Is(err, errInvalidCursor) {
		t.Fatalf("invalid cursor error = %v", err)
	}
}

func TestShortcutPreferencesValidateAndPersist(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	p, err := getPrefs(db)
	if err != nil {
		t.Fatalf("get prefs: %v", err)
	}
	p.KeyboardShortcuts = map[string]*preference.ShortcutBinding{
		"note.save":    {Steps: []preference.ShortcutStep{{Key: "s", Modifiers: []string{"Mod"}}}},
		"editor.title": {Steps: []preference.ShortcutStep{{Key: "/", Modifiers: []string{"Mod"}}, {Key: "t", Modifiers: []string{}}}},
		"format.link":  nil,
	}
	p.ShortcutPrefix = preference.ShortcutBinding{Steps: []preference.ShortcutStep{{Key: "e", Modifiers: []string{"Mod"}}}}
	p.ShortcutConfirmationSkips = map[string]bool{"note.new": true}
	p.StartView = "zen"
	p.ZenFontSize = "1.1rem"
	p.ZenInteractivePreview = true
	if err := preference.Validate(p); err != nil {
		t.Fatalf("validate valid shortcuts: %v", err)
	}
	if err := savePrefs(db, p, nil); err != nil {
		t.Fatalf("save prefs: %v", err)
	}
	stored, err := getPrefs(db)
	if err != nil {
		t.Fatalf("reload prefs: %v", err)
	}
	if _, present := stored.KeyboardShortcuts["format.link"]; !present || stored.KeyboardShortcuts["format.link"] != nil || len(stored.KeyboardShortcuts["editor.title"].Steps) != 2 || stored.ShortcutPrefix.Steps[0].Key != "e" || !stored.ShortcutConfirmationSkips["note.new"] || stored.StartView != "zen" || stored.ZenFontSize != "1.1rem" || !stored.ZenInteractivePreview {
		t.Fatalf("stored shortcut preferences = %#v", stored)
	}

	invalid := &prefs{KeyboardShortcuts: map[string]*preference.ShortcutBinding{
		"bad id": {Steps: []preference.ShortcutStep{{Key: "s", Modifiers: []string{"Mod"}}}},
	}}
	if err := preference.Validate(invalid); err == nil {
		t.Fatal("invalid shortcut ID was accepted")
	}
	invalid = &prefs{KeyboardShortcuts: map[string]*preference.ShortcutBinding{
		"note.save": {Steps: []preference.ShortcutStep{{Key: "k", Modifiers: []string{"Mod"}}, {Key: "t", Modifiers: []string{"Shift"}}}},
	}}
	if err := preference.Validate(invalid); err == nil {
		t.Fatal("invalid sequence was accepted")
	}
	invalid = &prefs{ShortcutPrefix: preference.ShortcutBinding{Steps: []preference.ShortcutStep{{Key: "k", Modifiers: []string{}}}}}
	if err := preference.Validate(invalid); err == nil {
		t.Fatal("invalid shortcut prefix was accepted")
	}
	invalid = &prefs{StartView: "unknown"}
	if err := preference.Validate(invalid); err == nil {
		t.Fatal("invalid start view was accepted")
	}
}

func TestPrefsMigratesLegacyHidePreviewToStartView(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if _, err := db.Exec(`UPDATE prefs SET data = '{"hidePreview":true}' WHERE id = 1`); err != nil {
		t.Fatalf("store legacy preferences: %v", err)
	}
	p, err := getPrefs(db)
	if err != nil {
		t.Fatalf("get migrated preferences: %v", err)
	}
	if p.StartView != "editor" {
		t.Fatalf("legacy start view = %q, want editor", p.StartView)
	}
	if err := savePrefs(db, p, nil); err != nil {
		t.Fatalf("save migrated preferences: %v", err)
	}
	var stored string
	if err := db.QueryRow(`SELECT data FROM prefs WHERE id = 1`).Scan(&stored); err != nil {
		t.Fatalf("read stored preferences: %v", err)
	}
	if strings.Contains(stored, "hidePreview") || !strings.Contains(stored, `"startView":"editor"`) {
		t.Fatalf("stored migrated preferences = %s", stored)
	}
}
