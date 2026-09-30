package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/store"
)

const vaultArchiveRetention = 30 * 24 * time.Hour

type vaultResetRequest struct {
	Password           string          `json:"password"`
	VaultID            string          `json:"vault_id"`
	KDFSalt            string          `json:"kdf_salt"`
	KDFMemoryKiB       int             `json:"kdf_memory_kib"`
	KDFIterations      int             `json:"kdf_iterations"`
	AuthProof          string          `json:"auth_proof"`
	RecoveryProof      string          `json:"recovery_proof"`
	WrappedKey         json.RawMessage `json:"wrapped_key"`
	WrappedRecoveryKey json.RawMessage `json:"wrapped_recovery_key"`
}

func (a *app) handleVaultReset(w http.ResponseWriter, r *http.Request) {
	if a.password == "" {
		httpx.WriteAPIError(w, http.StatusForbidden, "vault_reset_unavailable", "new vault setup is not available")
		return
	}
	if a.rl != nil {
		ip := a.rl.RealIP(r)
		retryAfter, err := a.rl.LoginRetryAfter(ip)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_rate_limit_failed", "could not check reset attempts")
			return
		}
		if retryAfter > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			httpx.WriteJSONStatus(w, http.StatusTooManyRequests, map[string]any{
				"error": "too many attempts", "code": "login_rate_limited", "retry_after": retryAfter,
			})
			return
		}
	}
	var request vaultResetRequest
	if !httpx.DecodeJSON(w, r, &request, 32<<10) {
		return
	}
	if subtle.ConstantTimeCompare([]byte(request.Password), []byte(a.password)) != 1 {
		if a.rl != nil {
			a.rl.RecordLoginAttempt(a.rl.RealIP(r), false)
		}
		httpx.WriteAPIError(w, http.StatusUnauthorized, "invalid_credentials", "wrong Vylk password")
		return
	}
	vaultID, validVaultID := decodeVaultIdentifier(request.VaultID)
	salt, validSalt := decodeVaultIdentifier(request.KDFSalt)
	proof, validProof := decodeVaultProof(request.AuthProof)
	recoveryProof, validRecoveryProof := decodeVaultProof(request.RecoveryProof)
	if !validVaultID || !validSalt || !validProof || !validRecoveryProof || len(vaultID) != 16 || len(salt) != 16 ||
		request.KDFMemoryKiB < 19*1024 || request.KDFMemoryKiB > 256*1024 ||
		request.KDFIterations < 2 || request.KDFIterations > 10 ||
		!validVaultEnvelope(request.WrappedKey) || !validVaultEnvelope(request.WrappedRecoveryKey) {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_vault_reset", "invalid new vault credentials")
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverVaultFileOperations(); err != nil {
		httpx.WriteAPIError(w, http.StatusServiceUnavailable, "note_file_recovery_blocked", "encrypted file recovery is pending")
		return
	}
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultReady || config.Epoch < 1 {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_reset_unavailable", "encrypted vault cannot be reset right now")
		return
	}
	if config.Epoch == int64(^uint64(0)>>1) {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_reset_unavailable", "encrypted vault cannot be reset right now")
		return
	}
	now := time.Now().UTC()
	if err := a.cleanupVaultArchivesLocked(now); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_archive_cleanup_failed", "could not prepare the protected archive")
		return
	}
	if _, err := a.archiveEncryptedVault(now); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_archive_failed", "could not preserve the current encrypted vault")
		return
	}

	deviceID := a.browserDeviceID(r)
	tx, err := a.db.Begin()
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new vault")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE vault_config SET mode = ?, vault_id = ?, kdf_salt = ?,
		kdf_memory_kib = ?, kdf_iterations = ?, auth_hash = ?, recovery_hash = ?,
		wrapped_key = ?, wrapped_recovery_key = ?, epoch = ?, backup_path = '', backup_ready = 0
		WHERE id = 1`, store.VaultReady, request.VaultID, request.KDFSalt,
		request.KDFMemoryKiB, request.KDFIterations, vaultProofHash(proof), vaultProofHash(recoveryProof),
		string(request.WrappedKey), string(request.WrappedRecoveryKey), config.Epoch+1); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new vault")
		return
	}
	for _, table := range []string{
		"vault_notes", "vault_staged_notes", "vault_file_operations", "sync_changes",
		"sync_operations", "sync_device_state",
	} {
		if _, err := tx.Exec("DELETE FROM " + table); err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new vault")
			return
		}
	}
	if _, err := tx.Exec("UPDATE sync_operation_stats SET operation_count = 0, payload_bytes = 0 WHERE id = 1"); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new vault")
		return
	}
	if err := a.sessions.RevokeAllTx(tx, "vault_reset"); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new vault")
		return
	}
	token, err := a.sessions.CreateDeviceTx(tx, deviceID, browserDeviceName(r.UserAgent()))
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new session")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_reset_failed", "could not create the new vault")
		return
	}
	if a.rl != nil {
		_ = a.rl.RecordLoginAttempt(a.rl.RealIP(r), true)
	}
	if a.noteCache != nil {
		a.noteCache.Clear()
	}
	// The complete old tree is already quarantined. Any unreferenced leftover
	// ciphertext remains outside the new vault and cannot be synced.
	_ = os.RemoveAll(filepath.Join(a.notesDir, ".vylk-vault"))
	if deviceID, err := a.sessions.DeviceID(token); err == nil {
		a.setDeviceCookie(w, r, deviceID)
	}
	a.setSessionCookie(w, r, token)
	a.publishChange("notes")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	httpx.WriteJSON(w, map[string]any{
		"ok": true, "vault_id": request.VaultID, "epoch": config.Epoch + 1,
		"archive_expires_at": now.Add(vaultArchiveRetention).Format(time.RFC3339),
	})
}

func (a *app) archiveEncryptedVault(now time.Time) (string, error) {
	archiveID, err := randID()
	if err != nil {
		return "", err
	}
	root := filepath.Join(a.notesDir, ".vylk-vault-archives")
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("vault archive directory is invalid")
	}
	name := fmt.Sprintf("archive-%d-%s", now.Unix(), archiveID)
	directory := filepath.Join(root, name)
	if err := os.Mkdir(directory, 0700); err != nil {
		return "", err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(directory)
		}
	}()
	databasePath := filepath.Join(directory, "vault.db")
	if _, err := a.db.Exec("VACUUM INTO ?", databasePath); err != nil {
		return "", fmt.Errorf("snapshot vault database: %w", err)
	}
	archiveDB, err := store.OpenDB(databasePath)
	if err != nil {
		return "", fmt.Errorf("open protected vault snapshot: %w", err)
	}
	_, scrubErr := archiveDB.Exec("DELETE FROM sessions")
	if scrubErr == nil {
		_, scrubErr = archiveDB.Exec("DELETE FROM rate_limits")
	}
	closeErr := archiveDB.Close()
	if scrubErr != nil {
		return "", fmt.Errorf("remove authentication state from vault snapshot: %w", scrubErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close protected vault snapshot: %w", closeErr)
	}
	if err := os.Chmod(databasePath, 0600); err != nil {
		return "", err
	}
	if err := copyVaultCiphertextTree(filepath.Join(a.notesDir, ".vylk-vault"), filepath.Join(directory, "notes", ".vylk-vault")); err != nil {
		return "", err
	}
	if err := notepkg.SyncDirectory(directory); err != nil {
		return "", err
	}
	if err := notepkg.SyncDirectory(root); err != nil {
		return "", err
	}
	complete = true
	return directory, nil
}

func copyVaultCiphertextTree(source, destination string) error {
	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("encrypted vault files are unavailable for quarantine")
	}
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == source {
			return nil
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("cannot archive symlink %q", relative)
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.Mkdir(target, 0700)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("cannot archive non-regular vault file %q", relative)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			input.Close()
			return err
		}
		if _, err := io.CopyBuffer(output, input, make([]byte, 32<<10)); err != nil {
			input.Close()
			output.Close()
			return err
		}
		if err := input.Close(); err != nil {
			output.Close()
			return err
		}
		if err := output.Sync(); err != nil {
			output.Close()
			return err
		}
		return output.Close()
	})
}

func (a *app) cleanupVaultArchives(now time.Time) error {
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	return a.cleanupVaultArchivesLocked(now)
}

func (a *app) cleanupVaultArchivesLocked(now time.Time) error {
	root := filepath.Join(a.notesDir, ".vylk-vault-archives")
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("vault archive directory is invalid")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "archive-") {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(entry.Name(), "archive-"), "-", 2)
		if len(parts) != 2 {
			continue
		}
		created, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || now.Sub(time.Unix(created, 0)) < vaultArchiveRetention {
			continue
		}
		path := filepath.Join(root, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) vaultArchiveCleanupLoop() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		if err := a.cleanupVaultArchives(time.Now().UTC()); err != nil {
			// Expiry is best-effort; an archive remains protected if cleanup fails.
			continue
		}
	}
}
