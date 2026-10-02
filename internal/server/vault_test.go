package server

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vylk/internal/auth"
	"vylk/internal/event"
	notepkg "vylk/internal/note"
	"vylk/internal/store"
	"vylk/internal/web"
)

type heldVaultBody struct {
	io.Reader
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *heldVaultBody) Read(p []byte) (int, error) {
	b.once.Do(func() {
		close(b.entered)
		<-b.release
	})
	return b.Reader.Read(p)
}

func vaultTestMaxSummary(t *testing.T) json.RawMessage {
	t.Helper()
	metadata, err := json.Marshal(map[string]string{"title": strings.Repeat("\x00", notepkg.MaxTitleBytes), "tags": strings.Repeat("\x00", notepkg.MaxTagsBytes)})
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(map[string]any{"v": 1, "nonce": "AAAAAAAAAAAAAAAA", "ciphertext": base64.RawURLEncoding.EncodeToString(make([]byte, len(metadata)+16))})
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}

func TestVaultSummaryAllowsWorstCaseLegacyMetadata(t *testing.T) {
	envelope := vaultTestMaxSummary(t)
	if !validVaultSummary(envelope) {
		t.Fatalf("valid legacy metadata rejected: %d envelope bytes", len(envelope))
	}
	oversized := append(append(json.RawMessage{}, envelope...), []byte(strings.Repeat(" ", 1024))...)
	if validVaultSummary(oversized) {
		t.Fatal("oversized summary accepted")
	}
}

func vaultTestEnvelope() json.RawMessage {
	return json.RawMessage(`{"v":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}`)
}

func vaultTestRequest(t *testing.T, method, path string, body any, handler http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	var input strings.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = *strings.NewReader(string(encoded))
	}
	r := httptest.NewRequest(method, path, &input)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

func TestDisabledVaultChangesBlockEveryMutationRoute(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessionStore(db)
	token, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	assets, err := web.New(web.DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, sessions: sessions, password: "secret", disableVaultChanges: true}
	handler := newHandler(a, assets, 0)
	for _, path := range []string{
		"/api/vault/reset",
		"/api/vault/credentials",
		"/api/vault/migration/start",
		"/api/vault/migration/stage",
		"/api/vault/migration/verify",
		"/api/vault/migration/commit",
	} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
			request.AddCookie(&http.Cookie{Name: "session", Value: token})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"vault_changes_disabled"`) {
				t.Fatalf("response = %d: %s", response.Code, response.Body.String())
			}
		})
	}
	for _, path := range []string{"/api/vault/bootstrap", "/api/notes", "/api/check"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.AddCookie(&http.Cookie{Name: "session", Value: token})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("response = %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestVaultMigrationCutoverRemovesActivePlaintext(t *testing.T) {
	root := t.TempDir()
	notesDir := filepath.Join(root, "notes")
	if err := os.Mkdir(notesDir, 0700); err != nil {
		t.Fatal(err)
	}
	db, err := openDB(filepath.Join(root, "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertNote(db, "note-a", "Private title", "note-a.md", "secret"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "note-a.md"), []byte("Private body"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, notesDir: notesDir, password: "old-password", sessions: auth.NewSessionStore(db), noteCache: notepkg.NewCache()}
	a.rl, err = auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatal(err)
	}
	a.noteCache.Set("note-a", "Private body")
	tokenBeforeMigration, err := a.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	held := &heldVaultBody{Reader: strings.NewReader(`{"device_id":"held_device","operations":[{"client_sequence":1,"op_id":"held_save","type":"note.save","note_id":"unknown-note","base_revision":1,"title":"held","content":"post-cutover-plaintext"}]}`), entered: make(chan struct{}), release: make(chan struct{})}
	heldRequest := httptest.NewRequest(http.MethodPost, "/api/sync/push", held)
	heldRequest.AddCookie(&http.Cookie{Name: "session", Value: tokenBeforeMigration})
	heldResponse := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.vaultRoute(a.handleSyncPush, a.handleVaultSyncPush, true)(heldResponse, heldRequest)
	}()
	select {
	case <-held.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not reach body decoding")
	}
	t.Cleanup(func() {
		select {
		case <-held.release:
		default:
			close(held.release)
		}
		<-done
	})
	id := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	proof := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	start := vaultMigrationStart{OldPassword: "old-password", VaultID: id, KDFSalt: id,
		KDFMemoryKiB: 19 * 1024, KDFIterations: 2, AuthProof: proof,
		RecoveryProof: proof, WrappedKey: vaultTestEnvelope(), WrappedRecoveryKey: vaultTestEnvelope()}
	w := vaultTestRequest(t, http.MethodPost, "/api/vault/migration/start", start, a.handleVaultMigrationStart)
	if w.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", w.Code, w.Body.String())
	}
	for _, mutation := range []struct {
		name    string
		method  string
		path    string
		body    any
		handler http.HandlerFunc
	}{
		{"save", http.MethodPost, "/api/notes", map[string]any{"title": "held", "content": "held"}, a.handleSaveNote},
		{"delete", http.MethodDelete, "/api/notes/note-a?base_revision=1", nil, a.handleDeleteNote},
		{"push", http.MethodPost, "/api/sync/push", map[string]any{"device_id": "held_device", "operations": []any{}}, a.handleSyncPush},
	} {
		t.Run("preparing_rejects_"+mutation.name, func(t *testing.T) {
			response := vaultTestRequest(t, mutation.method, mutation.path, mutation.body, mutation.handler)
			if response.Code != http.StatusLocked {
				t.Fatalf("mutation = %d: %s", response.Code, response.Body.String())
			}
		})
	}
	w = vaultTestRequest(t, http.MethodGet, "/api/vault/migration/next", nil, a.handleVaultMigrationNext)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "note-a") {
		t.Fatalf("next = %d: %s", w.Code, w.Body.String())
	}
	stage := vaultStagedRequest{ID: "note-a", Revision: 1, Summary: vaultTestMaxSummary(t), Body: vaultTestEnvelope()}
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/migration/stage", stage, a.handleVaultMigrationStage)
	if w.Code != http.StatusOK {
		t.Fatalf("stage = %d: %s", w.Code, w.Body.String())
	}
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/migration/verify",
		map[string]any{"id": "note-a", "body_hash": notepkg.ContentHash(stage.Body)}, a.handleVaultMigrationVerify)
	if w.Code != http.StatusOK {
		t.Fatalf("verify = %d: %s", w.Code, w.Body.String())
	}
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/migration/commit", map[string]any{}, a.handleVaultMigrationCommit)
	if w.Code != http.StatusOK {
		t.Fatalf("commit = %d: %s", w.Code, w.Body.String())
	}
	close(held.release)
	<-done
	if heldResponse.Code != http.StatusUpgradeRequired {
		t.Fatalf("held legacy write = %d: %s", heldResponse.Code, heldResponse.Body.String())
	}
	var heldOperations int
	if err := db.QueryRow("SELECT COUNT(*) FROM sync_operations WHERE device_id = 'held_device'").Scan(&heldOperations); err != nil || heldOperations != 0 {
		t.Fatalf("held plaintext operation persisted: %d, %v", heldOperations, err)
	}
	config, err := store.GetVaultConfig(db)
	if err != nil || config.Mode != store.VaultReady {
		t.Fatalf("vault config = %#v, %v", config, err)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "note-a.md")); !os.IsNotExist(err) {
		t.Fatalf("legacy note still exists: %v", err)
	}
	if _, ok := a.noteCache.Get("note-a"); ok {
		t.Fatal("plaintext note remained in the server cache")
	}
	var legacyCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM notes").Scan(&legacyCount); err != nil || legacyCount != 0 {
		t.Fatalf("legacy row count = %d, %v", legacyCount, err)
	}
	if _, err := os.Stat(config.BackupPath); config.BackupPath != "" || !os.IsNotExist(err) {
		t.Fatalf("backup path remains: %q, %v", config.BackupPath, err)
	}
	note, err := a.readVaultNote("note-a")
	if err != nil || string(note.Body) != string(stage.Body) || string(note.Summary) != string(stage.Summary) {
		t.Fatalf("encrypted note = %#v, %v", note, err)
	}
	base := int64(1)
	operation := vaultSyncOperation{ClientSequence: 1, OpID: "operation_1", Type: "note.save",
		NoteID: "note-a", BaseRevision: &base, Epoch: 1,
		Summary: vaultTestEnvelope(), Body: vaultTestEnvelope()}
	a.events = event.NewBroker()
	changes := a.events.Subscribe()
	defer a.events.Unsubscribe(changes)
	gap := operation
	gap.ClientSequence = 3
	gap.OpID = "gap_operation"
	w = vaultTestRequest(t, http.MethodPost, "/api/sync/push",
		vaultSyncPushRequest{DeviceID: "device_a", Operations: []vaultSyncOperation{operation, gap}}, a.handleVaultSyncPush)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"status":"applied"`) {
		t.Fatalf("encrypted sync push = %d: %s", w.Code, w.Body.String())
	}
	select {
	case change := <-changes:
		if change.Type != "notes" {
			t.Fatalf("unexpected change: %#v", change)
		}
	default:
		t.Fatal("partial encrypted push did not publish its committed note")
	}
	var storedOperation string
	if err := db.QueryRow("SELECT operation FROM sync_operations WHERE device_id = ? AND client_sequence = 1", "device_a").Scan(&storedOperation); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(storedOperation, "Private") || strings.Contains(storedOperation, "ciphertext") {
		t.Fatalf("unexpected sync operation payload: %s", storedOperation)
	}
	operation.ClientSequence = 2
	operation.OpID = "operation_2"
	operation.Epoch = 2
	w = vaultTestRequest(t, http.MethodPost, "/api/sync/push",
		vaultSyncPushRequest{DeviceID: "device_a", Operations: []vaultSyncOperation{operation}}, a.handleVaultSyncPush)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "stale_vault_epoch") {
		t.Fatalf("stale epoch push = %d: %s", w.Code, w.Body.String())
	}
	var lastSequence int
	if err := db.QueryRow("SELECT last_sequence FROM sync_device_state WHERE device_id = ?", "device_a").Scan(&lastSequence); err != nil || lastSequence != 1 {
		t.Fatalf("device sequence advanced on stale epoch: %d, %v", lastSequence, err)
	}
	operation.Epoch = 1
	w = vaultTestRequest(t, http.MethodPost, "/api/sync/push",
		vaultSyncPushRequest{DeviceID: "device_a", Operations: []vaultSyncOperation{operation}}, a.handleVaultSyncPush)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"conflict"`) ||
		!strings.Contains(w.Body.String(), `"current_revision":2`) {
		t.Fatalf("conflicting encrypted push = %d: %s", w.Code, w.Body.String())
	}
	staged, err := filepath.Glob(filepath.Join(notesDir, ".vylk-vault", "epoch-1", notepkg.StageFilePrefix+"*"))
	if err != nil || len(staged) != 0 {
		t.Fatalf("conflicting encrypted push left staged files: %v, %v", staged, err)
	}
	note, err = a.readVaultNote("note-a")
	if err != nil || note.Revision != 2 {
		t.Fatalf("conflicting push changed note: %#v, %v", note, err)
	}
	token, err := a.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	newProof := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("x", 32)))
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/credentials",
		vaultCredentialRequest{Kind: "master", CurrentProof: proof, NewProof: newProof,
			WrappedKey: vaultTestEnvelope(), KDFSalt: id,
			KDFMemoryKiB: 19 * 1024, KDFIterations: 2}, a.handleVaultCredentialChange)
	if w.Code != http.StatusOK || a.sessions.Valid(token) {
		t.Fatalf("master change did not revoke old sessions: %d: %s", w.Code, w.Body.String())
	}
	config, err = store.GetVaultConfig(db)
	if err != nil || subtle.ConstantTimeCompare(config.AuthHash, vaultProofHash([]byte(strings.Repeat("x", 32)))) != 1 {
		t.Fatalf("master proof was not replaced: %#v, %v", config, err)
	}
	token, err = a.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	previousRecoveryHash := append([]byte(nil), config.RecoveryHash...)
	recoveryProof := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("r", 32)))
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/credentials",
		vaultCredentialRequest{Kind: "recovery", CurrentProof: proof, NewProof: recoveryProof,
			WrappedKey: vaultTestEnvelope()}, a.handleVaultCredentialChange)
	if w.Code != http.StatusUnauthorized || !a.sessions.Valid(token) {
		t.Fatalf("old master proof changed credentials or revoked sessions: %d: %s", w.Code, w.Body.String())
	}
	config, err = store.GetVaultConfig(db)
	if err != nil || subtle.ConstantTimeCompare(config.RecoveryHash, previousRecoveryHash) != 1 {
		t.Fatalf("failed credential update changed recovery proof: %#v, %v", config, err)
	}
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/credentials",
		vaultCredentialRequest{Kind: "recovery", CurrentProof: newProof, NewProof: recoveryProof,
			WrappedKey: vaultTestEnvelope()}, a.handleVaultCredentialChange)
	if w.Code != http.StatusOK || a.sessions.Valid(token) {
		t.Fatalf("recovery change did not revoke old sessions: %d: %s", w.Code, w.Body.String())
	}
	config, err = store.GetVaultConfig(db)
	if err != nil || subtle.ConstantTimeCompare(config.RecoveryHash, vaultProofHash([]byte(strings.Repeat("r", 32)))) != 1 {
		t.Fatalf("recovery proof was not replaced: %#v, %v", config, err)
	}
}

func TestVaultMigrationRejectsUnexpectedPlaintextFile(t *testing.T) {
	root := t.TempDir()
	db, err := openDB(filepath.Join(root, "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	notesDir := filepath.Join(root, "notes")
	if err := os.Mkdir(notesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "orphan.md"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, notesDir: notesDir, password: "old-password"}
	id := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	proof := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	w := vaultTestRequest(t, http.MethodPost, "/api/vault/migration/start",
		vaultMigrationStart{OldPassword: "old-password", VaultID: id, KDFSalt: id,
			KDFMemoryKiB: 19 * 1024, KDFIterations: 2, AuthProof: proof,
			RecoveryProof: proof, WrappedKey: vaultTestEnvelope(), WrappedRecoveryKey: vaultTestEnvelope()},
		a.handleVaultMigrationStart)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "unexpected_note_files") {
		t.Fatalf("start = %d: %s", w.Code, w.Body.String())
	}
}

func TestVaultResetArchivesOldVaultAndRejectsOldEpoch(t *testing.T) {
	root := t.TempDir()
	db, err := openDB(filepath.Join(root, "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	notesDir := filepath.Join(root, "notes")
	oldEpochDir := filepath.Join(notesDir, ".vylk-vault", "epoch-4")
	if err := os.MkdirAll(oldEpochDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldEpochDir, "note-a.md.enc"), []byte("ciphertext"), 0600); err != nil {
		t.Fatal(err)
	}
	oldID := base64.RawURLEncoding.EncodeToString(bytesOf(1, 16))
	newID := base64.RawURLEncoding.EncodeToString(bytesOf(2, 16))
	newSalt := base64.RawURLEncoding.EncodeToString(bytesOf(3, 16))
	proof := base64.RawURLEncoding.EncodeToString(bytesOf(4, 32))
	if _, err := db.Exec(`INSERT INTO vault_config
		(id, mode, vault_id, kdf_salt, kdf_memory_kib, kdf_iterations, auth_hash, recovery_hash,
		wrapped_key, wrapped_recovery_key, epoch) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4)`,
		store.VaultReady, oldID, newSalt, 19*1024, 2, vaultProofHash([]byte("old")),
		vaultProofHash([]byte("old-recovery")), string(vaultTestEnvelope()), string(vaultTestEnvelope())); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO vault_notes
		(id, summary, filename, created_at, updated_at, revision, epoch)
		VALUES ('note-a', ?, 'note-a.md.enc', '2026-01-01', '2026-01-01', 1, 4)`,
		string(vaultTestEnvelope())); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, notesDir: notesDir, password: "shared-password", sessions: auth.NewSessionStore(db)}
	a.rl, err = auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatal(err)
	}
	oldSession, err := a.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	request := vaultResetRequest{Password: "shared-password", VaultID: newID, KDFSalt: newSalt,
		KDFMemoryKiB: 19 * 1024, KDFIterations: 2, AuthProof: proof, RecoveryProof: proof,
		WrappedKey: vaultTestEnvelope(), WrappedRecoveryKey: vaultTestEnvelope()}
	wrong := request
	wrong.Password = "wrong"
	w := vaultTestRequest(t, http.MethodPost, "/api/vault/reset", wrong, a.handleVaultReset)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password reset = %d: %s", w.Code, w.Body.String())
	}
	config, err := store.GetVaultConfig(db)
	if err != nil || config.VaultID != oldID || config.Epoch != 4 {
		t.Fatalf("failed reset changed vault: %#v, %v", config, err)
	}
	w = vaultTestRequest(t, http.MethodPost, "/api/vault/reset", request, a.handleVaultReset)
	if w.Code != http.StatusOK {
		t.Fatalf("reset = %d: %s", w.Code, w.Body.String())
	}
	if a.sessions.Valid(oldSession) {
		t.Fatal("old session remained valid after reset")
	}
	var newSession string
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "session" {
			newSession = cookie.Value
		}
	}
	if newSession == "" || !a.sessions.Valid(newSession) {
		t.Fatal("reset did not create a valid new session cookie")
	}
	config, err = store.GetVaultConfig(db)
	if err != nil || config.VaultID != newID || config.Epoch != 5 {
		t.Fatalf("new vault config = %#v, %v", config, err)
	}
	var noteCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM vault_notes").Scan(&noteCount); err != nil || noteCount != 0 {
		t.Fatalf("active notes = %d, %v", noteCount, err)
	}
	archives, err := filepath.Glob(filepath.Join(notesDir, ".vylk-vault-archives", "archive-*"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("archives = %v, %v", archives, err)
	}
	archiveDB, err := openDB(filepath.Join(archives[0], "vault.db"))
	if err != nil {
		t.Fatal(err)
	}
	var archivedSessions int
	if err := archiveDB.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&archivedSessions); err != nil {
		t.Fatal(err)
	}
	if err := archiveDB.Close(); err != nil {
		t.Fatal(err)
	}
	if archivedSessions != 0 {
		t.Fatalf("archive contains %d old authentication sessions", archivedSessions)
	}
	archivedCiphertext, err := os.ReadFile(filepath.Join(archives[0], "notes", ".vylk-vault", "epoch-4", "note-a.md.enc"))
	if err != nil || string(archivedCiphertext) != "ciphertext" {
		t.Fatalf("archived encrypted note = %q, %v", archivedCiphertext, err)
	}
	if _, err := os.Stat(oldEpochDir); !os.IsNotExist(err) {
		t.Fatalf("old ciphertext tree remains active: %v", err)
	}
	base := int64(1)
	operation := vaultSyncOperation{ClientSequence: 1, OpID: "old_epoch_op", Type: "note.save",
		NoteID: "note-a", BaseRevision: &base, Epoch: 4,
		Summary: vaultTestEnvelope(), Body: vaultTestEnvelope()}
	w = vaultTestRequest(t, http.MethodPost, "/api/sync/push",
		vaultSyncPushRequest{DeviceID: "old_device", Operations: []vaultSyncOperation{operation}}, a.handleVaultSyncPush)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "stale_vault_epoch") {
		t.Fatalf("old epoch push = %d: %s", w.Code, w.Body.String())
	}
}

func bytesOf(value byte, count int) []byte {
	result := make([]byte, count)
	for i := range result {
		result[i] = value
	}
	return result
}
