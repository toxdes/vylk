package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vylk/internal/auth"
	notepkg "vylk/internal/note"
	"vylk/internal/notecrypt"
)

func TestSanitizePathRejectsSiblingPrefix(t *testing.T) {
	base := t.TempDir()
	inside, err := notepkg.SanitizePath(base, "note.md")
	if err != nil {
		t.Fatalf("sanitize inside path: %v", err)
	}
	if inside != filepath.Join(base, "note.md") {
		t.Fatalf("inside path = %q", inside)
	}
	if _, err := notepkg.SanitizePath(base, "../"+filepath.Base(base)+"-other.md"); err == nil {
		t.Fatal("sibling path with matching prefix was accepted")
	}
}

func TestReadSecretFromFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte("value\n"), 0600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Setenv("VYLK_TEST_SECRET_FILE", path)
	value, err := readSecret("VYLK_TEST_SECRET")
	if err != nil || value != "value" {
		t.Fatalf("read secret = %q, %v", value, err)
	}
}

func TestVersionedEncryptionBindsTheNoteID(t *testing.T) {
	config, err := notecrypt.New(t.TempDir(), "", "hex:0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
	if err != nil {
		t.Fatalf("create encryption config: %v", err)
	}
	ciphertext, err := config.Encrypt([]byte("private note"), "note-a")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if !notecrypt.IsVersionedEnvelope(ciphertext) {
		t.Fatal("new ciphertext does not have a versioned envelope")
	}
	plaintext, err := config.Decrypt(ciphertext, "note-a")
	if err != nil || string(plaintext) != "private note" {
		t.Fatalf("decrypt = %q, %v", plaintext, err)
	}
	if _, err := config.Decrypt(ciphertext, "note-b"); err == nil {
		t.Fatal("ciphertext was accepted under a different note ID")
	}
}

func TestPasswordEncryptionReadsLegacyNotes(t *testing.T) {
	dir := t.TempDir()
	config, err := notecrypt.New(dir, "correct horse battery staple", "")
	if err != nil {
		t.Fatalf("create password config: %v", err)
	}
	legacy, err := notecrypt.EncryptLegacy([]byte("old note"), notecrypt.DeriveLegacyKey("correct horse battery staple"))
	if err != nil {
		t.Fatalf("encrypt legacy: %v", err)
	}
	plaintext, err := config.Decrypt(legacy, "old-id")
	if err != nil || string(plaintext) != "old note" {
		t.Fatalf("decrypt legacy = %q, %v", plaintext, err)
	}
	info, err := os.Stat(filepath.Join(dir, notecrypt.MetadataFilename))
	if err != nil {
		t.Fatalf("encryption metadata: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("metadata mode = %o, want 600", info.Mode().Perm())
	}
}

func TestMigrateEncryptionUpgradesLegacyFiles(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "legacy-id", "Legacy", "legacy-id.md", ""); err != nil {
		t.Fatalf("create legacy note: %v", err)
	}
	legacy, err := notecrypt.EncryptLegacy([]byte("migrate me"), notecrypt.DeriveLegacyKey("old secret"))
	if err != nil {
		t.Fatalf("encrypt legacy: %v", err)
	}
	path := filepath.Join(notesDir, "legacy-id.md")
	if err := notepkg.WriteFile(path, legacy); err != nil {
		t.Fatalf("write legacy note: %v", err)
	}
	config, err := notecrypt.New(notesDir, "old secret", "")
	if err != nil {
		t.Fatalf("new config: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, encryption: config}
	count, err := migrateEncryption(a)
	if err != nil || count != 1 {
		t.Fatalf("migrate = %d, %v", count, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migrated note: %v", err)
	}
	if !notecrypt.IsVersionedEnvelope(data) {
		t.Fatal("migrated note does not use versioned encryption")
	}
	plaintext, err := config.Decrypt(data, "legacy-id")
	if err != nil || string(plaintext) != "migrate me" {
		t.Fatalf("decrypt migrated note = %q, %v", plaintext, err)
	}
}

func TestNormalizeTags(t *testing.T) {
	if got, want := notepkg.NormalizeTags(" work,personal, work, , personal "), "work,personal"; got != want {
		t.Fatalf("notepkg.NormalizeTags() = %q, want %q", got, want)
	}
}

func TestNoteTagsAreIndexedAndSorted(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "first", "First", "first.md", "zebra,alpha"); err != nil {
		t.Fatalf("insert first: %v", err)
	}
	if err := upsertNote(db, "second", "Second", "second.md", "alpha"); err != nil {
		t.Fatalf("insert second: %v", err)
	}
	tags, err := listTags(db)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(tags) != 2 || tags[0] != "alpha" || tags[1] != "zebra" {
		t.Fatalf("tags = %#v", tags)
	}
	notes, err := listNotes(db, "alpha")
	if err != nil {
		t.Fatalf("filter notes: %v", err)
	}
	if len(notes) != 2 {
		t.Fatalf("filtered notes = %d, want 2", len(notes))
	}
}

func TestNoteRevisionsAndTombstonesUseServerChanges(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "sync-note", "First", "sync-note.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if err := upsertNote(db, "sync-note", "Second", "sync-note.md", ""); err != nil {
		t.Fatalf("update note: %v", err)
	}
	n, err := getNote(db, "sync-note")
	if err != nil || n.Revision != 2 {
		t.Fatalf("revision = %#v, %v; want 2", n, err)
	}
	if err := deleteNote(db, "sync-note"); err != nil {
		t.Fatalf("delete note: %v", err)
	}
	var revision int64
	var deleted int
	if err := db.QueryRow("SELECT revision, deleted FROM sync_changes WHERE note_id = ? ORDER BY sequence DESC LIMIT 1", "sync-note").Scan(&revision, &deleted); err != nil {
		t.Fatalf("read tombstone: %v", err)
	}
	if revision != 3 || deleted != 1 {
		t.Fatalf("tombstone = revision %d, deleted %d; want 3, 1", revision, deleted)
	}
	if err := upsertNote(db, "sync-note", "Recreated", "sync-note.md", ""); err != nil {
		t.Fatalf("recreate note: %v", err)
	}
	n, err = getNote(db, "sync-note")
	if err != nil || n.Revision != 4 {
		t.Fatalf("recreated revision = %#v, %v; want 4", n, err)
	}
	changes, err := listSyncChanges(db, 0, 2)
	if err != nil || len(changes.Changes) != 2 || !changes.HasMore || changes.NextSequence != changes.Changes[1].Sequence {
		t.Fatalf("first sync page = %#v, %v", changes, err)
	}
	changes, err = listSyncChanges(db, changes.NextSequence, 2)
	if err != nil || len(changes.Changes) != 2 || changes.HasMore || changes.Changes[0].Deleted != true || changes.Changes[1].Revision != 4 {
		t.Fatalf("second sync page = %#v, %v", changes, err)
	}
}

func TestSyncMigrationSeedsExistingNotes(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("create migration table: %v", err)
	}
	for _, migration := range migrations[:5] {
		tx, err := db.Begin()
		if err != nil {
			t.Fatalf("begin migration %d: %v", migration.Version, err)
		}
		if err := migration.Up(tx); err != nil {
			tx.Rollback()
			t.Fatalf("apply migration %d: %v", migration.Version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.Version, "2025-01-01T00:00:00Z"); err != nil {
			tx.Rollback()
			t.Fatalf("record migration %d: %v", migration.Version, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit migration %d: %v", migration.Version, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO notes (id, title, filename, tags, created_at, updated_at)
		VALUES ('existing', 'Existing', 'existing.md', '', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z')`); err != nil {
		t.Fatalf("insert existing note: %v", err)
	}
	if err := initDB(db); err != nil {
		t.Fatalf("upgrade database: %v", err)
	}
	changes, err := listSyncChanges(db, 0, 10)
	if err != nil || len(changes.Changes) != 1 {
		t.Fatalf("seeded changes = %#v, %v", changes, err)
	}
	change := changes.Changes[0]
	if change.NoteID != "existing" || change.Revision != 1 || change.Deleted || change.ChangedAt != "2025-01-02T00:00:00Z" {
		t.Fatalf("seeded change = %#v", change)
	}
}

func TestCheckNoteRevisionDetectsUpdatesAndTombstones(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := checkNoteRevision(db, "new", 0); err != nil {
		t.Fatalf("new note revision: %v", err)
	}
	if err := upsertNote(db, "note", "First", "note.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if err := checkNoteRevision(db, "note", 1); err != nil {
		t.Fatalf("current revision: %v", err)
	}
	if err := checkNoteRevision(db, "note", 0); !errors.Is(err, errRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
	if err := deleteNote(db, "note"); err != nil {
		t.Fatalf("delete note: %v", err)
	}
	if err := checkNoteRevision(db, "note", 1); !errors.Is(err, errRevisionConflict) {
		t.Fatalf("deleted revision error = %v", err)
	}
}

func TestSaveRejectsStaleOfflineRevisionBeforeReplacingFile(t *testing.T) {
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
	first := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(`{"id":"offline-note","title":"First","content":"first body","tags":"","base_revision":0}`))
	first.Header.Set("Content-Type", "application/json")
	firstResult := httptest.NewRecorder()
	a.handleSaveNote(firstResult, first)
	if firstResult.Code != http.StatusOK {
		t.Fatalf("first save status = %d: %s", firstResult.Code, firstResult.Body.String())
	}

	missingRevision := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(`{"id":"offline-note","title":"Unsafe","content":"unsafe body","tags":""}`))
	missingRevision.Header.Set("Content-Type", "application/json")
	missingRevisionResult := httptest.NewRecorder()
	a.handleSaveNote(missingRevisionResult, missingRevision)
	if missingRevisionResult.Code != http.StatusBadRequest {
		t.Fatalf("missing save revision status = %d: %s", missingRevisionResult.Code, missingRevisionResult.Body.String())
	}

	missingDeleteRevision := httptest.NewRequest(http.MethodDelete, "/api/notes/offline-note", nil)
	missingDeleteResult := httptest.NewRecorder()
	a.handleDeleteNote(missingDeleteResult, missingDeleteRevision)
	if missingDeleteResult.Code != http.StatusBadRequest {
		t.Fatalf("missing delete revision status = %d: %s", missingDeleteResult.Code, missingDeleteResult.Body.String())
	}

	stale := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(`{"id":"offline-note","title":"Stale","content":"stale body","tags":"","base_revision":0}`))
	stale.Header.Set("Content-Type", "application/json")
	staleResult := httptest.NewRecorder()
	a.handleSaveNote(staleResult, stale)
	if staleResult.Code != http.StatusConflict {
		t.Fatalf("stale save status = %d: %s", staleResult.Code, staleResult.Body.String())
	}
	var conflict map[string]any
	if err := json.Unmarshal(staleResult.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode stale save conflict: %v", err)
	}
	if conflict["code"] != "note_revision_conflict" || conflict["note_id"] != "offline-note" || conflict["current_revision"] != float64(1) {
		t.Fatalf("stale save conflict = %#v", conflict)
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "offline-note.md"))
	if err != nil || string(data) != "first body" {
		t.Fatalf("note file after stale save = %q, %v", data, err)
	}
}

func TestNoteContentReadWaitsForNoteWriteLock(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	config, err := notecrypt.New(dir, "test password", "")
	if err != nil {
		t.Fatalf("create encryption config: %v", err)
	}
	if err := upsertNote(db, "read-lock-note", "Read lock", "read-lock-note.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	ciphertext, err := config.Encrypt([]byte("consistent content"), "read-lock-note")
	if err != nil {
		t.Fatalf("encrypt note: %v", err)
	}
	if err := notepkg.WriteFile(filepath.Join(dir, "read-lock-note.md"), ciphertext); err != nil {
		t.Fatalf("write note: %v", err)
	}
	a := &app{db: db, notesDir: dir, encryption: config, noteCache: notepkg.NewCache()}

	a.noteMu.Lock()
	result := make(chan struct {
		data noteWithContent
		err  error
	}, 1)
	go func() {
		data, err := a.loadNoteWithContent("read-lock-note")
		result <- struct {
			data noteWithContent
			err  error
		}{data: data, err: err}
	}()

	select {
	case <-result:
		t.Fatal("note content read passed through the write lock")
	case <-time.After(25 * time.Millisecond):
	}
	a.noteMu.Unlock()

	select {
	case read := <-result:
		if read.err != nil || read.data.Revision != 1 || read.data.Content != "consistent content" {
			t.Fatalf("note read = %#v, %v", read.data, read.err)
		}
	case <-time.After(time.Second):
		t.Fatal("note content read did not complete after releasing the lock")
	}
}

func TestSessionsPersistAcrossStoreRestart(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	first := auth.NewSessionStore(db)
	token, err := first.Create()
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if !auth.NewSessionStore(db).Valid(token) {
		t.Fatal("session was not available after recreating the store")
	}
	var storedHash string
	if err := db.QueryRow("SELECT token_hash FROM sessions").Scan(&storedHash); err != nil {
		t.Fatalf("read stored session: %v", err)
	}
	if storedHash == token {
		t.Fatal("session token was stored without hashing")
	}
	first.Remove(token)
	if auth.NewSessionStore(db).Valid(token) {
		t.Fatal("removed session remained valid")
	}
}

func TestAuthenticatedActivityRenewsNearExpirySessions(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	rl, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	a := &app{db: db, sessions: auth.NewSessionStore(db), rl: rl}

	nearToken, err := a.sessions.Create()
	if err != nil {
		t.Fatalf("create near-expiry session: %v", err)
	}
	nearExpiry := time.Now().UTC().Add(auth.SessionRenewalThreshold - time.Hour).Format(time.RFC3339)
	if _, err := db.Exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", nearExpiry, auth.SessionTokenHash(nearToken)); err != nil {
		t.Fatalf("set near expiry: %v", err)
	}
	nearRequest := httptest.NewRequest(http.MethodGet, "/api/check", nil)
	nearRequest.AddCookie(&http.Cookie{Name: "session", Value: nearToken})
	nearResult := httptest.NewRecorder()
	a.auth(a.handleCheck)(nearResult, nearRequest)
	if nearResult.Code != http.StatusOK {
		t.Fatalf("near-expiry authenticated request = %d: %s", nearResult.Code, nearResult.Body.String())
	}
	refreshedCookie := nearResult.Result().Cookies()
	if len(refreshedCookie) != 1 || refreshedCookie[0].MaxAge != int(auth.SessionLifetime.Seconds()) {
		t.Fatalf("renewal cookie = %#v; want max-age %d", refreshedCookie, int(auth.SessionLifetime.Seconds()))
	}
	var renewedExpiry string
	if err := db.QueryRow("SELECT expires_at FROM sessions WHERE token_hash = ?", auth.SessionTokenHash(nearToken)).Scan(&renewedExpiry); err != nil {
		t.Fatalf("read renewed expiry: %v", err)
	}
	renewedAt, err := time.Parse(time.RFC3339, renewedExpiry)
	if err != nil || renewedAt.Before(time.Now().UTC().Add(auth.SessionLifetime-2*time.Minute)) {
		t.Fatalf("renewed expiry = %q; want approximately 180 days from now", renewedExpiry)
	}

	farToken, err := a.sessions.Create()
	if err != nil {
		t.Fatalf("create far-expiry session: %v", err)
	}
	farExpiry := time.Now().UTC().Add(auth.SessionRenewalThreshold + time.Hour).Format(time.RFC3339)
	if _, err := db.Exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", farExpiry, auth.SessionTokenHash(farToken)); err != nil {
		t.Fatalf("set far expiry: %v", err)
	}
	farRequest := httptest.NewRequest(http.MethodGet, "/api/check", nil)
	farRequest.AddCookie(&http.Cookie{Name: "session", Value: farToken})
	farResult := httptest.NewRecorder()
	a.auth(a.handleCheck)(farResult, farRequest)
	if farResult.Code != http.StatusOK {
		t.Fatalf("far-expiry authenticated request = %d: %s", farResult.Code, farResult.Body.String())
	}
	if got := farResult.Header().Get("Set-Cookie"); got != "" {
		t.Fatalf("far-expiry request refreshed cookie %q", got)
	}

	expiredToken, err := a.sessions.Create()
	if err != nil {
		t.Fatalf("create expired session: %v", err)
	}
	if _, err := db.Exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", time.Now().UTC().Add(-time.Minute).Format(time.RFC3339), auth.SessionTokenHash(expiredToken)); err != nil {
		t.Fatalf("set expired session: %v", err)
	}
	expiredRequest := httptest.NewRequest(http.MethodGet, "/api/check", nil)
	expiredRequest.AddCookie(&http.Cookie{Name: "session", Value: expiredToken})
	expiredResult := httptest.NewRecorder()
	a.auth(a.handleCheck)(expiredResult, expiredRequest)
	if expiredResult.Code != http.StatusUnauthorized {
		t.Fatalf("expired session status = %d: %s", expiredResult.Code, expiredResult.Body.String())
	}
}
