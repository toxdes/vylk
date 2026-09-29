package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/notesync"
	"vylk/internal/preference"
	"vylk/internal/store"
)

type vaultSyncOperation struct {
	ClientSequence int64                   `json:"client_sequence"`
	OpID           string                  `json:"op_id"`
	Type           string                  `json:"type"`
	NoteID         string                  `json:"note_id,omitempty"`
	BaseRevision   *int64                  `json:"base_revision,omitempty"`
	Summary        json.RawMessage         `json:"summary,omitempty"`
	Body           json.RawMessage         `json:"body,omitempty"`
	Epoch          int64                   `json:"epoch,omitempty"`
	Pinned         bool                    `json:"pinned,omitempty"`
	Prefs          *preference.Preferences `json:"prefs,omitempty"`
}

type vaultSyncPushRequest struct {
	DeviceID   string               `json:"device_id"`
	Operations []vaultSyncOperation `json:"operations"`
}

func validateVaultOperation(operation vaultSyncOperation) bool {
	if operation.ClientSequence < 1 || !notesync.ValidIdentifier(operation.OpID) {
		return false
	}
	switch operation.Type {
	case "note.save":
		return notepkg.ValidID(operation.NoteID) && operation.BaseRevision != nil &&
			*operation.BaseRevision >= 0 && operation.Epoch > 0 &&
			validVaultSummary(operation.Summary) && validVaultEnvelope(operation.Body)
	case "note.pin":
		return notepkg.ValidID(operation.NoteID) && operation.BaseRevision != nil &&
			*operation.BaseRevision >= 0 && operation.Epoch > 0
	case "note.delete":
		return notepkg.ValidID(operation.NoteID) && operation.BaseRevision != nil &&
			*operation.BaseRevision > 0 && operation.Epoch > 0
	case "prefs.save":
		return operation.Prefs != nil && preference.Validate(operation.Prefs) == nil &&
			preference.ValidatePatch(operation.Prefs.SyncPatch) == nil
	case "noop":
		return true
	default:
		return false
	}
}

func (a *app) handleVaultSyncPush(w http.ResponseWriter, r *http.Request) {
	var request vaultSyncPushRequest
	if !httpx.DecodeJSON(w, r, &request, 8<<20) {
		return
	}
	if !notesync.ValidIdentifier(request.DeviceID) || len(request.Operations) > 100 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_sync_request", "invalid sync request")
		return
	}
	for _, operation := range request.Operations {
		if !validateVaultOperation(operation) {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_encrypted_operation", "invalid encrypted sync operation")
			return
		}
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultReady {
		httpx.WriteAPIError(w, http.StatusLocked, "vault_unavailable", "encrypted vault is unavailable")
		return
	}
	// Check the entire batch before touching the device sequence. A stale device
	// can rebase its unsent operations without first creating an acknowledgement.
	for _, operation := range request.Operations {
		if operation.Type != "prefs.save" && operation.Type != "noop" && operation.Epoch != config.Epoch {
			httpx.WriteJSONStatus(w, http.StatusConflict, map[string]any{
				"code": "stale_vault_epoch", "error": "refresh vault keys before syncing",
				"epoch": config.Epoch,
			})
			return
		}
	}
	if err := a.recoverVaultFileOperations(); err != nil {
		httpx.WriteAPIError(w, http.StatusServiceUnavailable, "note_file_recovery_blocked", "encrypted file recovery is pending")
		return
	}
	lastSequence, err := syncDeviceSequence(a.db, request.DeviceID)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "read_sync_state_failed", "could not read sync state")
		return
	}
	response := syncPushResponse{Acknowledged: make([]syncOperationResult, 0, len(request.Operations)), ExpectedSequence: lastSequence + 1}
	var notesChanged, prefsChanged bool
	for _, operation := range request.Operations {
		if operation.ClientSequence <= lastSequence {
			stored, err := storedSyncOperation(a.db, request.DeviceID, operation.ClientSequence, operation.OpID)
			if errors.Is(err, sql.ErrNoRows) {
				response.Acknowledged = append(response.Acknowledged, syncOperationResult{ClientSequence: operation.ClientSequence, OpID: operation.OpID, Status: "compacted"})
				continue
			}
			if err != nil {
				httpx.WriteAPIError(w, http.StatusConflict, "invalid_replayed_operation", "invalid replayed operation")
				return
			}
			response.Acknowledged = append(response.Acknowledged, stored)
			continue
		}
		if operation.ClientSequence != lastSequence+1 {
			httpx.WriteJSONStatus(w, http.StatusConflict, response)
			return
		}
		result, err := a.applyVaultSyncOperation(request.DeviceID, operation, config.Epoch)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "apply_sync_operation_failed", "could not apply encrypted sync operation")
			return
		}
		if result.Status == "applied" {
			if operation.Type == "prefs.save" {
				prefsChanged = true
			} else if operation.Type != "noop" {
				notesChanged = true
			}
		}
		response.Acknowledged = append(response.Acknowledged, result)
		lastSequence = operation.ClientSequence
		response.ExpectedSequence = lastSequence + 1
	}
	if notesChanged {
		a.publishChange("notes")
	}
	if prefsChanged {
		a.publishChange("preferences")
	}
	httpx.WriteJSON(w, response)
}

func (a *app) applyVaultSyncOperation(deviceID string, operation vaultSyncOperation, epoch int64) (syncOperationResult, error) {
	result := syncOperationResult{ClientSequence: operation.ClientSequence, OpID: operation.OpID, Status: "applied"}
	var stageRelative string
	var fileOperation *vaultFileOperation
	committed := false
	defer func() {
		if stageRelative != "" && (!committed || fileOperation == nil) {
			_ = os.Remove(filepath.Join(a.notesDir, stageRelative))
		}
	}()
	if operation.Type == "note.save" {
		directory, err := a.ensureVaultGeneration(epoch)
		if err != nil {
			return result, err
		}
		stageName, err := notepkg.StageFile(directory, operation.Body)
		if err != nil {
			return result, err
		}
		stageRelative = filepath.Join(filepath.Dir(a.vaultFilename(operation.NoteID, epoch)), stageName)
	}
	tx, err := a.db.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339)
	switch operation.Type {
	case "note.save", "note.pin", "note.delete":
		current, err := store.CheckVaultRevisionTx(tx, operation.NoteID, *operation.BaseRevision)
		if errors.Is(err, store.ErrRevisionConflict) {
			result.Status, result.CurrentRevision = "conflict", current
			break
		}
		if err != nil {
			return result, err
		}
		switch operation.Type {
		case "note.save":
			filename := a.vaultFilename(operation.NoteID, epoch)
			result.Revision, err = store.UpsertVaultNoteTx(tx, operation.NoteID, string(operation.Summary), filename, epoch, now)
			if err != nil {
				return result, err
			}
			if current == 0 && operation.Pinned {
				if err := tx.QueryRow("SELECT COALESCE(MAX(pin_order), 0) + 1 FROM vault_notes WHERE pinned = 1").Scan(&result.PinOrder); err != nil {
					return result, err
				}
				if _, err := tx.Exec("UPDATE vault_notes SET pinned = 1, pin_order = ? WHERE id = ?", result.PinOrder, operation.NoteID); err != nil {
					return result, err
				}
			}
			operationID, err := randID()
			if err != nil {
				return result, err
			}
			fileOperation = &vaultFileOperation{ID: operationID, Action: fileOperationReplace,
				NoteID: operation.NoteID, StageName: stageRelative, TargetName: filename,
				ExpectedHash: notepkg.ContentHash(operation.Body)}
		case "note.pin":
			var exists int
			if err := tx.QueryRow("SELECT COUNT(*) FROM vault_notes WHERE id = ?", operation.NoteID).Scan(&exists); err != nil {
				return result, err
			}
			if exists == 0 {
				result.Status, result.CurrentRevision = "conflict", current
				break
			}
			if operation.Pinned {
				if err := tx.QueryRow("SELECT COALESCE(MAX(pin_order), 0) + 1 FROM vault_notes WHERE pinned = 1").Scan(&result.PinOrder); err != nil {
					return result, err
				}
			}
			if _, err := tx.Exec("UPDATE vault_notes SET pinned = ?, pin_order = ?, revision = revision + 1 WHERE id = ?", operation.Pinned, result.PinOrder, operation.NoteID); err != nil {
				return result, err
			}
			result.Revision = current + 1
			if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 0, ?)", operation.NoteID, result.Revision, now); err != nil {
				return result, err
			}
			if err := store.CompactSyncChangesTx(tx); err != nil {
				return result, err
			}
		case "note.delete":
			var filename string
			if err := tx.QueryRow("SELECT filename FROM vault_notes WHERE id = ?", operation.NoteID).Scan(&filename); err != nil {
				return result, err
			}
			result.Revision, err = store.DeleteVaultNoteTx(tx, operation.NoteID)
			if err != nil {
				return result, err
			}
			operationID, err := randID()
			if err != nil {
				return result, err
			}
			fileOperation = &vaultFileOperation{ID: operationID, Action: fileOperationDelete,
				NoteID: operation.NoteID, TargetName: filename}
		}
	case "prefs.save":
		current, err := store.GetPrefsTx(tx)
		if err != nil {
			return result, err
		}
		if len(operation.Prefs.SyncPatch) > 0 {
			if operation.BaseRevision != nil && *operation.BaseRevision != current.Revision {
				conflict, err := preference.PatchConflicts(current, operation.Prefs)
				if err != nil {
					return result, err
				}
				if conflict {
					result.Status, result.CurrentRevision = "conflict", current.Revision
					break
				}
			}
			next, err := preference.ApplyPatch(current, operation.Prefs.SyncPatch)
			if err != nil {
				return result, err
			}
			if err := store.SavePrefsTx(tx, next, nil); err != nil {
				return result, err
			}
			result.Revision = next.Revision
			break
		}
		if operation.BaseRevision != nil && *operation.BaseRevision != current.Revision {
			result.Status, result.CurrentRevision = "conflict", current.Revision
			break
		}
		if err := store.SavePrefsTx(tx, operation.Prefs, nil); err != nil {
			return result, err
		}
		result.Revision = operation.Prefs.Revision
	}
	if fileOperation != nil {
		if err := recordVaultFileOperation(tx, *fileOperation); err != nil {
			return result, err
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	const operationMarker = `{"encrypted":true}`
	if _, err := tx.Exec(`INSERT INTO sync_operations
		(device_id, client_sequence, op_id, op_type, result, operation, applied_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, deviceID, operation.ClientSequence, operation.OpID,
		operation.Type, string(encoded), operationMarker, now); err != nil {
		return result, err
	}
	if _, err := tx.Exec(`UPDATE sync_operation_stats
		SET operation_count = operation_count + 1, payload_bytes = payload_bytes + ? WHERE id = 1`,
		len(operationMarker)); err != nil {
		return result, err
	}
	if err := compactSyncOperationAcknowledgements(tx); err != nil {
		return result, err
	}
	if _, err := tx.Exec("UPDATE sync_device_state SET last_sequence = ? WHERE device_id = ?", operation.ClientSequence, deviceID); err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	committed = true
	if fileOperation != nil {
		if err := a.completeVaultFileOperation(*fileOperation); err != nil {
			return result, err
		}
	}
	return result, nil
}
