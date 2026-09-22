package server

import (
	"database/sql"
	"encoding/base64"
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

const syncOperationCompactionBatchSize = 100
const compactedOperationPayload = `{"compacted":true}`

var maxSyncOperationPayloadBytes int64 = 32 << 20
var maxSyncOperationAcknowledgements int64 = 100000

func (a *app) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	var request syncPushRequest
	if !httpx.DecodeJSON(w, r, &request, notesync.MaxPushBytes) {
		return
	}
	if !notesync.ValidIdentifier(request.DeviceID) || len(request.Operations) > 100 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_sync_request", "invalid sync request")
		return
	}
	for index, operation := range request.Operations {
		if err := notesync.Validate(operation); err != nil {
			httpx.WriteJSONStatus(w, http.StatusBadRequest, map[string]any{
				"error":           err.Error(),
				"code":            "invalid_sync_operation",
				"permanent":       true,
				"operation_index": index,
				"client_sequence": operation.ClientSequence,
				"op_id":           operation.OpID,
			})
			return
		}
	}

	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverFileOperations(); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "recover_file_operations_failed", "could not recover pending file operations")
		return
	}
	for _, operation := range request.Operations {
		if operation.Type != "note.save" && operation.Type != "note.delete" && operation.Type != "note.pin" {
			continue
		}
		if blocked, err := a.fileOperationBlocked(operation.NoteID); err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "inspect_file_operations_failed", "could not inspect pending file operations")
			return
		} else if blocked {
			httpx.WriteJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
				"error":   "note file recovery requires attention",
				"code":    "note_file_recovery_blocked",
				"note_id": operation.NoteID,
			})
			return
		}
	}

	lastSequence, err := syncDeviceSequence(a.db, request.DeviceID)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "read_sync_state_failed", "could not read sync state")
		return
	}
	response := syncPushResponse{Acknowledged: make([]syncOperationResult, 0, len(request.Operations)), ExpectedSequence: lastSequence + 1}
	var notesChanged, preferencesChanged bool
	defer func() {
		if preferencesChanged {
			a.publishChange("preferences")
		}
		if notesChanged {
			a.publishChange("notes")
		}
	}()
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
		result, err := a.applySyncOperation(request.DeviceID, operation)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "apply_sync_operation_failed", "could not apply sync operation")
			return
		}
		if result.Status == "applied" {
			if operation.Type == "prefs.save" {
				preferencesChanged = true
			} else if operation.Type == "note.save" || operation.Type == "note.delete" || operation.Type == "note.pin" {
				notesChanged = true
			}
		}
		response.Acknowledged = append(response.Acknowledged, result)
		lastSequence = operation.ClientSequence
		response.ExpectedSequence = lastSequence + 1
	}
	httpx.WriteJSON(w, response)
}

func syncDeviceSequence(db *sql.DB, deviceID string) (int64, error) {
	if _, err := db.Exec("INSERT OR IGNORE INTO sync_device_state (device_id, last_sequence) VALUES (?, 0)", deviceID); err != nil {
		return 0, err
	}
	var sequence int64
	err := db.QueryRow("SELECT last_sequence FROM sync_device_state WHERE device_id = ?", deviceID).Scan(&sequence)
	return sequence, err
}

func storedSyncOperation(db *sql.DB, deviceID string, sequence int64, opID string) (syncOperationResult, error) {
	var storedOpID, encoded string
	if err := db.QueryRow("SELECT op_id, result FROM sync_operations WHERE device_id = ? AND client_sequence = ?", deviceID, sequence).Scan(&storedOpID, &encoded); err != nil {
		return syncOperationResult{}, err
	}
	if storedOpID != opID {
		return syncOperationResult{}, errors.New("operation sequence belongs to another operation")
	}
	var result syncOperationResult
	if err := json.Unmarshal([]byte(encoded), &result); err != nil {
		return syncOperationResult{}, err
	}
	return result, nil
}

func (a *app) applySyncOperation(deviceID string, operation syncOperationRequest) (syncOperationResult, error) {
	tx, err := a.db.Begin()
	if err != nil {
		return syncOperationResult{}, err
	}
	defer tx.Rollback()

	result := syncOperationResult{ClientSequence: operation.ClientSequence, OpID: operation.OpID, Status: "applied"}
	now := time.Now().UTC().Format(time.RFC3339)
	var stagedName string
	committed := false
	defer func() {
		if !committed && stagedName != "" {
			_ = os.Remove(filepath.Join(a.notesDir, stagedName))
		}
	}()
	var pendingFileOperation *fileOperation
	var cachedContent *string
	switch operation.Type {
	case "note.save":
		currentRevision, err := store.CheckNoteRevisionTx(tx, operation.NoteID, *operation.BaseRevision)
		if errors.Is(err, errRevisionConflict) {
			result.Status = "conflict"
			result.CurrentRevision = currentRevision
			break
		}
		if err != nil {
			return syncOperationResult{}, err
		}
		enc, err := a.encryption.Encrypt([]byte(operation.Content), operation.NoteID)
		if err != nil {
			return syncOperationResult{}, err
		}
		stagedName, err = notepkg.StageFile(a.notesDir, enc)
		if err != nil {
			return syncOperationResult{}, err
		}
		if err := store.UpsertNoteTx(tx, operation.NoteID, operation.Title, operation.NoteID+".md", notepkg.NormalizeTags(operation.Tags), now); err != nil {
			return syncOperationResult{}, err
		}
		// Pin state is folded into creation so a note can be pinned before its
		// first server revision exists. Existing notes use ordered note.pin
		// operations, preventing a stale content save from changing their pin.
		if currentRevision == 0 && operation.Pinned {
			result.PinOrder, err = store.NextPinOrderTx(tx)
			if err != nil {
				return syncOperationResult{}, err
			}
			if _, err := tx.Exec("UPDATE notes SET pinned = 1, pin_order = ? WHERE id = ?", result.PinOrder, operation.NoteID); err != nil {
				return syncOperationResult{}, err
			}
		}
		if err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", operation.NoteID).Scan(&result.Revision); err != nil {
			return syncOperationResult{}, err
		}
		fileOperationID, err := randID()
		if err != nil {
			return syncOperationResult{}, err
		}
		pendingFileOperation = &fileOperation{ID: fileOperationID, Action: fileOperationReplace, NoteID: operation.NoteID, StageName: stagedName, ExpectedHash: notepkg.ContentHash(enc)}
		if err := recordFileOperation(tx, *pendingFileOperation); err != nil {
			return syncOperationResult{}, err
		}
		cachedContent = &operation.Content
	case "note.pin":
		currentRevision, err := store.CheckNoteRevisionTx(tx, operation.NoteID, *operation.BaseRevision)
		if errors.Is(err, errRevisionConflict) {
			result.Status = "conflict"
			result.CurrentRevision = currentRevision
			break
		}
		if err != nil {
			return syncOperationResult{}, err
		}
		var exists int
		if err := tx.QueryRow("SELECT COUNT(*) FROM notes WHERE id = ?", operation.NoteID).Scan(&exists); err != nil {
			return syncOperationResult{}, err
		}
		if exists == 0 {
			result.Status = "conflict"
			result.CurrentRevision = currentRevision
			break
		}
		if operation.Pinned {
			result.PinOrder, err = store.NextPinOrderTx(tx)
			if err != nil {
				return syncOperationResult{}, err
			}
		}
		if _, err := tx.Exec("UPDATE notes SET pinned = ?, pin_order = ?, revision = revision + 1 WHERE id = ?", operation.Pinned, result.PinOrder, operation.NoteID); err != nil {
			return syncOperationResult{}, err
		}
		if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 0, ?)", operation.NoteID, currentRevision+1, now); err != nil {
			return syncOperationResult{}, err
		}
		if err := store.CompactSyncChangesTx(tx); err != nil {
			return syncOperationResult{}, err
		}
		result.Revision = currentRevision + 1
	case "note.delete":
		currentRevision, err := store.CheckNoteRevisionTx(tx, operation.NoteID, *operation.BaseRevision)
		if errors.Is(err, errRevisionConflict) {
			result.Status = "conflict"
			result.CurrentRevision = currentRevision
			break
		}
		if err != nil {
			return syncOperationResult{}, err
		}
		n, err := store.GetNoteTx(tx, operation.NoteID)
		if err != nil {
			return syncOperationResult{}, err
		}
		if err := store.DeleteNoteTx(tx, operation.NoteID, now); err != nil {
			return syncOperationResult{}, err
		}
		result.Revision = currentRevision + 1
		fileOperationID, err := randID()
		if err != nil {
			return syncOperationResult{}, err
		}
		pendingFileOperation = &fileOperation{ID: fileOperationID, Action: fileOperationDelete, NoteID: n.ID}
		if err := recordFileOperation(tx, *pendingFileOperation); err != nil {
			return syncOperationResult{}, err
		}
	case "prefs.save":
		current, err := store.GetPrefsTx(tx)
		if err != nil {
			return syncOperationResult{}, err
		}
		if len(operation.Prefs.SyncPatch) > 0 {
			if operation.BaseRevision != nil && *operation.BaseRevision != current.Revision {
				conflict, err := preference.PatchConflicts(current, operation.Prefs)
				if err != nil {
					return syncOperationResult{}, err
				}
				if conflict {
					result.Status = "conflict"
					result.CurrentRevision = current.Revision
					break
				}
			}
			next, err := preference.ApplyPatch(current, operation.Prefs.SyncPatch)
			if err != nil {
				return syncOperationResult{}, err
			}
			if err := store.SavePrefsTx(tx, next, nil); err != nil {
				return syncOperationResult{}, err
			}
			result.Revision = next.Revision
			break
		}
		if operation.BaseRevision != nil && *operation.BaseRevision != current.Revision {
			result.Status = "conflict"
			result.CurrentRevision = current.Revision
			break
		}
		if err := store.SavePrefsTx(tx, operation.Prefs, nil); err != nil {
			return syncOperationResult{}, err
		}
		result.Revision = operation.Prefs.Revision
	case "noop":
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		return syncOperationResult{}, err
	}
	encodedOperation, err := a.encodeSyncOperation(deviceID, operation)
	if err != nil {
		return syncOperationResult{}, err
	}
	if _, err := tx.Exec("INSERT INTO sync_operations (device_id, client_sequence, op_id, op_type, result, operation, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)", deviceID, operation.ClientSequence, operation.OpID, operation.Type, string(encoded), encodedOperation, now); err != nil {
		return syncOperationResult{}, err
	}
	if _, err := tx.Exec("UPDATE sync_operation_stats SET operation_count = operation_count + 1, payload_bytes = payload_bytes + ? WHERE id = 1", len(encodedOperation)); err != nil {
		return syncOperationResult{}, err
	}
	if err := compactSyncOperationPayloads(tx); err != nil {
		return syncOperationResult{}, err
	}
	if err := compactSyncOperationAcknowledgements(tx); err != nil {
		return syncOperationResult{}, err
	}
	if _, err := tx.Exec("UPDATE sync_device_state SET last_sequence = ? WHERE device_id = ?", operation.ClientSequence, deviceID); err != nil {
		return syncOperationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return syncOperationResult{}, err
	}
	committed = true
	if pendingFileOperation != nil {
		if err := a.completeFileOperation(*pendingFileOperation); err != nil {
			return syncOperationResult{}, err
		}
	}
	if cachedContent != nil {
		a.noteCache.Set(operation.NoteID, *cachedContent)
	} else if operation.Type == "note.delete" {
		a.noteCache.Delete(operation.NoteID)
	}
	return result, nil
}

func compactSyncOperationAcknowledgements(tx *sql.Tx) error {
	var count int64
	if err := tx.QueryRow("SELECT operation_count FROM sync_operation_stats WHERE id = 1").Scan(&count); err != nil {
		return err
	}
	if count <= maxSyncOperationAcknowledgements {
		return nil
	}
	batchSize := min(count-maxSyncOperationAcknowledgements, int64(syncOperationCompactionBatchSize))
	var removedBytes int64
	if err := tx.QueryRow(`SELECT COALESCE(SUM(payload_size), 0) FROM (
		SELECT length(operation) AS payload_size
		FROM sync_operations
		ORDER BY applied_at, device_id, client_sequence
		LIMIT ?
	)`, batchSize).Scan(&removedBytes); err != nil {
		return err
	}
	result, err := tx.Exec(`DELETE FROM sync_operations WHERE rowid IN (
		SELECT rowid FROM sync_operations
		ORDER BY applied_at, device_id, client_sequence
		LIMIT ?
	)`, batchSize)
	if err != nil {
		return err
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE sync_operation_stats
		SET operation_count = MAX(0, operation_count - ?),
		    payload_bytes = MAX(0, payload_bytes - ?)
		WHERE id = 1`, removed, removedBytes)
	return err
}

func compactSyncOperationPayloads(tx *sql.Tx) error {
	var total int64
	if err := tx.QueryRow("SELECT payload_bytes FROM sync_operation_stats WHERE id = 1").Scan(&total); err != nil {
		return err
	}
	if total <= maxSyncOperationPayloadBytes {
		return nil
	}
	type storedPayload struct {
		rowID int64
		size  int64
	}
	for total > maxSyncOperationPayloadBytes {
		rows, err := tx.Query(`SELECT rowid, length(operation) FROM sync_operations
			WHERE operation != ?
			ORDER BY applied_at, device_id, client_sequence
			LIMIT ?`, compactedOperationPayload, syncOperationCompactionBatchSize)
		if err != nil {
			return err
		}
		payloads := make([]storedPayload, 0, syncOperationCompactionBatchSize)
		for rows.Next() {
			var payload storedPayload
			if err := rows.Scan(&payload.rowID, &payload.size); err != nil {
				rows.Close()
				return err
			}
			payloads = append(payloads, payload)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(payloads) == 0 {
			break
		}
		var reduced int64
		for _, payload := range payloads {
			result, err := tx.Exec("UPDATE sync_operations SET operation = ? WHERE rowid = ? AND operation != ?", compactedOperationPayload, payload.rowID, compactedOperationPayload)
			if err != nil {
				return err
			}
			changed, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if changed > 0 {
				reduced += payload.size - int64(len(compactedOperationPayload))
			}
		}
		if reduced <= 0 {
			break
		}
		total -= reduced
		if _, err := tx.Exec("UPDATE sync_operation_stats SET payload_bytes = ? WHERE id = 1", total); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) encodeSyncOperation(deviceID string, operation syncOperationRequest) (string, error) {
	data, err := json.Marshal(operation)
	if err != nil {
		return "", err
	}
	if a.encryption == nil {
		return string(data), nil
	}
	encoded, err := a.encryption.Encrypt(data, "sync-operation:"+deviceID+":"+operation.OpID)
	if err != nil {
		return "", err
	}
	return "enc:" + base64.RawStdEncoding.EncodeToString(encoded), nil
}
