package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/store"
)

type vaultMigrationStart struct {
	OldPassword        string          `json:"old_password"`
	VaultID            string          `json:"vault_id"`
	KDFSalt            string          `json:"kdf_salt"`
	KDFMemoryKiB       int             `json:"kdf_memory_kib"`
	KDFIterations      int             `json:"kdf_iterations"`
	AuthProof          string          `json:"auth_proof"`
	RecoveryProof      string          `json:"recovery_proof"`
	WrappedKey         json.RawMessage `json:"wrapped_key"`
	WrappedRecoveryKey json.RawMessage `json:"wrapped_recovery_key"`
}

func vaultProofHash(proof []byte) []byte {
	hash := sha256.Sum256(proof)
	return hash[:]
}

func (a *app) handleVaultMigrationStart(w http.ResponseWriter, r *http.Request) {
	var request vaultMigrationStart
	if !httpx.DecodeJSON(w, r, &request, 32<<10) {
		return
	}
	_, validVaultID := decodeVaultIdentifier(request.VaultID)
	_, validSalt := decodeVaultIdentifier(request.KDFSalt)
	proof, validProof := decodeVaultProof(request.AuthProof)
	recoveryProof, validRecoveryProof := decodeVaultProof(request.RecoveryProof)
	if a.password == "" || subtle.ConstantTimeCompare([]byte(request.OldPassword), []byte(a.password)) != 1 ||
		!validVaultID || !validSalt || !validProof || !validRecoveryProof ||
		request.KDFMemoryKiB < 19*1024 || request.KDFMemoryKiB > 256*1024 ||
		request.KDFIterations < 2 || request.KDFIterations > 10 ||
		!validVaultEnvelope(request.WrappedKey) || !validVaultEnvelope(request.WrappedRecoveryKey) {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_vault_setup", "invalid vault setup or legacy password")
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
		return
	}
	if config != nil && (config.Mode != store.VaultPreparing || config.VaultID != request.VaultID) {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_setup_already_started", "another vault setup is active")
		return
	}
	if config == nil {
		if err := a.recoverFileOperations(); err != nil {
			httpx.WriteAPIError(w, http.StatusServiceUnavailable, "note_recovery_failed", "finish note file recovery before encrypting")
			return
		}
		var pending int
		if err := a.db.QueryRow("SELECT COUNT(*) FROM file_operations").Scan(&pending); err != nil || pending != 0 {
			httpx.WriteAPIError(w, http.StatusServiceUnavailable, "note_recovery_pending", "finish note file recovery before encrypting")
			return
		}
		if err := a.checkLegacyNoteFiles(); err != nil {
			httpx.WriteAPIError(w, http.StatusConflict, "unexpected_note_files", err.Error())
			return
		}
		backupPath, err := os.MkdirTemp(filepath.Dir(a.notesDir), ".vylk-migration-backup-")
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInsufficientStorage, "migration_backup_failed", "could not reserve backup directory")
			return
		}
		_, err = a.db.Exec(`INSERT INTO vault_config
			(id, mode, vault_id, kdf_salt, kdf_memory_kib, kdf_iterations, auth_hash,
			 recovery_hash, wrapped_key, wrapped_recovery_key, epoch, backup_path)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			store.VaultPreparing, request.VaultID, request.KDFSalt,
			request.KDFMemoryKiB, request.KDFIterations, vaultProofHash(proof),
			vaultProofHash(recoveryProof), string(request.WrappedKey),
			string(request.WrappedRecoveryKey), backupPath)
		if err != nil {
			_ = os.Remove(backupPath)
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_setup_failed", "could not start encryption")
			return
		}
		config, err = store.GetVaultConfig(a.db)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
			return
		}
	}
	if !config.BackupReady {
		if err := a.createVaultBackup(config.BackupPath); err != nil {
			httpx.WriteAPIError(w, http.StatusInsufficientStorage, "migration_backup_failed", "could not make a consistent local copy; free space and retry")
			return
		}
		if _, err := a.db.Exec("UPDATE vault_config SET backup_ready = 1 WHERE id = 1"); err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_setup_failed", "could not record backup completion")
			return
		}
	}
	httpx.WriteJSON(w, map[string]any{"ok": true, "epoch": 1})
}

func (a *app) handleVaultMigrationStatus(w http.ResponseWriter, r *http.Request) {
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_migration_not_started", "vault migration is not active")
		return
	}
	var source, staged, verified int64
	err = a.db.QueryRow(`SELECT
		(SELECT COUNT(*) FROM notes),
		(SELECT COUNT(*) FROM vault_staged_notes),
		(SELECT COUNT(*) FROM vault_staged_notes WHERE verified = 1)`).Scan(&source, &staged, &verified)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not count migration progress")
		return
	}
	httpx.WriteJSON(w, map[string]any{
		"mode": config.Mode, "backup_ready": config.BackupReady,
		"source_notes": source, "staged_notes": staged, "verified_notes": verified,
	})
}

func (a *app) handleVaultMigrationNext(w http.ResponseWriter, r *http.Request) {
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultPreparing || !config.BackupReady {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_migration_not_ready", "vault migration is not ready")
		return
	}
	rows, err := a.db.Query(`SELECT n.id, n.revision FROM notes n
		LEFT JOIN vault_staged_notes s ON s.id = n.id AND s.source_revision = n.revision AND s.verified = 1
		WHERE n.id > ? AND s.id IS NULL ORDER BY n.id LIMIT 100`, r.URL.Query().Get("after"))
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_migration_list_failed", "could not list remaining notes")
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0, 100)
	for rows.Next() {
		var id string
		var revision int64
		if err := rows.Scan(&id, &revision); err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_migration_list_failed", "could not list remaining notes")
			return
		}
		items = append(items, map[string]any{"id": id, "revision": revision})
	}
	if err := rows.Err(); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_migration_list_failed", "could not list remaining notes")
		return
	}
	httpx.WriteJSON(w, items)
}

type vaultStagedRequest struct {
	ID       string          `json:"id"`
	Revision int64           `json:"revision"`
	Summary  json.RawMessage `json:"summary"`
	Body     json.RawMessage `json:"body"`
}

func (a *app) handleVaultMigrationStage(w http.ResponseWriter, r *http.Request) {
	var request vaultStagedRequest
	if !httpx.DecodeJSON(w, r, &request, 8<<20) {
		return
	}
	if !notepkg.ValidID(request.ID) || request.Revision < 1 ||
		!validVaultSummary(request.Summary) || !validVaultEnvelope(request.Body) {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_encrypted_note", "invalid encrypted note envelope")
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultPreparing || !config.BackupReady {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_migration_not_ready", "vault migration is not ready")
		return
	}
	var revision int64
	if err := a.db.QueryRow("SELECT revision FROM notes WHERE id = ?", request.ID).Scan(&revision); err != nil || revision != request.Revision {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_note_changed", "note changed during migration")
		return
	}
	directory, err := a.ensureVaultGeneration(config.Epoch)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_stage_failed", "could not prepare encrypted storage")
		return
	}
	filename := a.vaultFilename(request.ID, config.Epoch)
	if err := notepkg.WriteFile(filepath.Join(a.notesDir, filename), request.Body); err != nil {
		httpx.WriteAPIError(w, http.StatusInsufficientStorage, "vault_stage_failed", "could not store encrypted note")
		return
	}
	if err := notepkg.SyncDirectory(directory); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_stage_failed", "could not sync encrypted note")
		return
	}
	_, err = a.db.Exec(`INSERT INTO vault_staged_notes
		(id, summary, filename, body_hash, source_revision, epoch, verified)
		VALUES (?, ?, ?, ?, ?, ?, 0)
		ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, filename = excluded.filename,
			body_hash = excluded.body_hash, source_revision = excluded.source_revision,
			epoch = excluded.epoch, verified = 0`,
		request.ID, string(request.Summary), filename, notepkg.ContentHash(request.Body),
		request.Revision, config.Epoch)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_stage_failed", "could not record encrypted note")
		return
	}
	httpx.WriteJSON(w, map[string]any{"ok": true})
}

func (a *app) handleVaultMigrationStagedNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var summary, filename string
	var revision, epoch int64
	err := a.db.QueryRow(`SELECT summary, filename, source_revision, epoch FROM vault_staged_notes WHERE id = ?`, id).Scan(&summary, &filename, &revision, &epoch)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusNotFound, "staged_note_not_found", "staged note not found")
		return
	}
	path, err := notepkg.SanitizePath(a.notesDir, filename)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "staged_note_invalid", "staged note path is invalid")
		return
	}
	body, err := os.ReadFile(path)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "staged_note_unavailable", "staged note body is unavailable")
		return
	}
	httpx.WriteJSON(w, map[string]any{
		"id": id, "revision": revision, "epoch": epoch,
		"summary": json.RawMessage(summary), "body": json.RawMessage(body),
		"body_hash": notepkg.ContentHash(body),
	})
}

func (a *app) handleVaultMigrationVerify(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ID       string `json:"id"`
		BodyHash string `json:"body_hash"`
	}
	if !httpx.DecodeJSON(w, r, &request, 4<<10) {
		return
	}
	if !notepkg.ValidID(request.ID) || len(request.BodyHash) != 64 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_verification", "invalid note verification")
		return
	}
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultPreparing {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_migration_not_ready", "vault migration is not ready")
		return
	}
	result, err := a.db.Exec(`UPDATE vault_staged_notes SET verified = 1
		WHERE id = ? AND body_hash = ? AND source_revision =
		(SELECT revision FROM notes WHERE id = ?)`, request.ID, request.BodyHash, request.ID)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_verify_failed", "could not verify staged note")
		return
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_verify_mismatch", "staged note changed or has wrong hash")
		return
	}
	httpx.WriteJSON(w, map[string]any{"ok": true})
}

func (a *app) handleVaultMigrationCommit(w http.ResponseWriter, r *http.Request) {
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultPreparing || !config.BackupReady {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_migration_not_ready", "vault migration is not ready")
		return
	}
	var source, staged int64
	err = a.db.QueryRow(`SELECT (SELECT COUNT(*) FROM notes),
		(SELECT COUNT(*) FROM vault_staged_notes s JOIN notes n ON n.id = s.id
		WHERE s.verified = 1 AND s.source_revision = n.revision AND s.epoch = ?)`, config.Epoch).Scan(&source, &staged)
	if err != nil || source != staged {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_migration_incomplete", "some notes are not verified")
		return
	}
	if err := a.checkLegacyNoteFiles(); err != nil {
		httpx.WriteAPIError(w, http.StatusConflict, "unexpected_note_files", err.Error())
		return
	}
	rows, err := a.db.Query("SELECT filename, body_hash FROM vault_staged_notes")
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_verify_failed", "could not verify encrypted files")
		return
	}
	for rows.Next() {
		var filename, expected string
		if err := rows.Scan(&filename, &expected); err != nil {
			rows.Close()
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_verify_failed", "could not verify encrypted files")
			return
		}
		path, err := notepkg.SanitizePath(a.notesDir, filename)
		if err != nil {
			rows.Close()
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_verify_failed", "invalid encrypted file path")
			return
		}
		matches, err := notepkg.MatchesHash(path, expected)
		if err != nil || !matches {
			rows.Close()
			httpx.WriteAPIError(w, http.StatusConflict, "vault_verify_failed", "encrypted file is missing or changed")
			return
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_verify_failed", "could not verify encrypted files")
		return
	}
	rows.Close()
	if _, err := a.db.Exec("PRAGMA secure_delete=ON"); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_commit_failed", "could not prepare secure database cleanup")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_commit_failed", "could not start cutover")
		return
	}
	defer tx.Rollback()
	statements := []string{
		`INSERT INTO vault_notes (id, summary, filename, pinned, pin_order, created_at, updated_at, revision, epoch)
		 SELECT n.id, s.summary, s.filename, n.pinned, n.pin_order, n.created_at, n.updated_at, n.revision, s.epoch
		 FROM notes n JOIN vault_staged_notes s ON s.id = n.id`,
		"DELETE FROM note_tags",
		"DROP TABLE note_metadata_fts",
		"DELETE FROM notes",
		"DELETE FROM sync_operations",
		"UPDATE sync_operation_stats SET operation_count = 0, payload_bytes = 0 WHERE id = 1",
		"DELETE FROM sessions",
		"UPDATE vault_config SET mode = 'cleaning' WHERE id = 1",
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_commit_failed", "could not complete cutover")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_commit_failed", "could not commit cutover")
		return
	}
	// Legacy reads during conversion may have filled the server's plaintext
	// note cache. Drop its references as soon as encrypted rows become active.
	a.noteCache = notepkg.NewCache()
	if err := a.finishVaultCleanup(config); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_cleanup_pending", "encrypted cutover succeeded; cleanup will resume after restart")
		return
	}
	httpx.WriteJSON(w, map[string]any{"ok": true, "mode": store.VaultReady})
}

func (a *app) finishVaultCleanup(config *store.VaultConfig) error {
	if config.Mode != store.VaultCleaning {
		// The caller just committed the mode transition.
		config.Mode = store.VaultCleaning
	}
	rows, err := a.db.Query("SELECT id FROM vault_staged_notes")
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if !notepkg.ValidID(id) {
			rows.Close()
			return errors.New("invalid note id during plaintext cleanup")
		}
		if err := os.Remove(filepath.Join(a.notesDir, id+".md")); err != nil && !errors.Is(err, os.ErrNotExist) {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := notepkg.SyncDirectory(a.notesDir); err != nil {
		return err
	}
	if _, err := a.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return err
	}
	if _, err := a.db.Exec("VACUUM"); err != nil {
		return err
	}
	if _, err := a.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return err
	}
	if config.BackupPath != "" {
		if filepath.Clean(filepath.Dir(config.BackupPath)) != filepath.Clean(filepath.Dir(a.notesDir)) ||
			!strings.HasPrefix(filepath.Base(config.BackupPath), ".vylk-migration-backup-") {
			return errors.New("invalid migration backup path during cleanup")
		}
		if err := os.RemoveAll(config.BackupPath); err != nil {
			return fmt.Errorf("remove migration backup: %w", err)
		}
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM vault_staged_notes"); err != nil {
		return err
	}
	if _, err := tx.Exec("UPDATE vault_config SET mode = ?, backup_path = '', backup_ready = 0 WHERE id = 1", store.VaultReady); err != nil {
		return err
	}
	return tx.Commit()
}

func (a *app) resumeVaultCleanup() error {
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultCleaning {
		return err
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	return a.finishVaultCleanup(config)
}
