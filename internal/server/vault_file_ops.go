package server

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	notepkg "vylk/internal/note"
	"vylk/internal/store"
)

type vaultFileOperation struct {
	ID           string
	Action       string
	NoteID       string
	StageName    string
	TargetName   string
	ExpectedHash string
}

func recordVaultFileOperation(tx *sql.Tx, operation vaultFileOperation) error {
	_, err := tx.Exec(`INSERT INTO vault_file_operations
		(id, action, note_id, stage_name, target_name, expected_hash, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, operation.ID, operation.Action, operation.NoteID,
		operation.StageName, operation.TargetName, operation.ExpectedHash,
		time.Now().UTC().Format(time.RFC3339))
	return err
}

func (a *app) completeVaultFileOperation(operation vaultFileOperation) error {
	if !notepkg.ValidID(operation.NoteID) ||
		!strings.HasPrefix(filepath.ToSlash(operation.TargetName), ".vylk-vault/epoch-") ||
		filepath.Base(operation.TargetName) != operation.NoteID+".md.enc" {
		return errors.New("invalid encrypted file operation target")
	}
	target, err := notepkg.SanitizePath(a.notesDir, operation.TargetName)
	if err != nil {
		return err
	}
	directory := filepath.Dir(target)
	switch operation.Action {
	case fileOperationReplace:
		if !strings.HasPrefix(filepath.Base(operation.StageName), notepkg.StageFilePrefix) ||
			filepath.Dir(operation.StageName) != filepath.Dir(operation.TargetName) {
			return errors.New("invalid encrypted staging file")
		}
		stage, err := notepkg.SanitizePath(a.notesDir, operation.StageName)
		if err != nil {
			return err
		}
		matches, err := notepkg.MatchesHash(stage, operation.ExpectedHash)
		if err == nil && !matches {
			return errors.New("encrypted staging file hash mismatch")
		}
		if err == nil {
			if err := os.Rename(stage, target); err != nil {
				return err
			}
		} else if errors.Is(err, os.ErrNotExist) {
			matches, err := notepkg.MatchesHash(target, operation.ExpectedHash)
			if err != nil || !matches {
				return fmt.Errorf("encrypted replacement is unavailable: %w", err)
			}
		} else {
			return err
		}
	case fileOperationDelete:
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	default:
		return errors.New("invalid encrypted file operation")
	}
	if err := notepkg.SyncDirectory(directory); err != nil {
		return err
	}
	_, err = a.db.Exec("DELETE FROM vault_file_operations WHERE id = ?", operation.ID)
	return err
}

func (a *app) recoverVaultFileOperations() error {
	rows, err := a.db.Query(`SELECT id, action, note_id, stage_name, target_name, expected_hash
		FROM vault_file_operations ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	operations := make([]vaultFileOperation, 0)
	for rows.Next() {
		var operation vaultFileOperation
		if err := rows.Scan(&operation.ID, &operation.Action, &operation.NoteID,
			&operation.StageName, &operation.TargetName, &operation.ExpectedHash); err != nil {
			rows.Close()
			return err
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, operation := range operations {
		if err := a.completeVaultFileOperation(operation); err != nil {
			return fmt.Errorf("recover encrypted file operation %s: %w", operation.ID, err)
		}
	}
	return nil
}

func (a *app) saveVaultNote(id string, summary, body []byte, epoch int64, expectedRevision int64) (store.VaultNote, error) {
	if _, err := a.ensureVaultGeneration(epoch); err != nil {
		return store.VaultNote{}, err
	}
	filename := a.vaultFilename(id, epoch)
	directory := filepath.Join(a.notesDir, filepath.Dir(filename))
	stageName, err := notepkg.StageFile(directory, body)
	if err != nil {
		return store.VaultNote{}, err
	}
	stageRelative := filepath.Join(filepath.Dir(filename), stageName)
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(filepath.Join(a.notesDir, stageRelative))
		}
	}()
	tx, err := a.db.Begin()
	if err != nil {
		return store.VaultNote{}, err
	}
	defer tx.Rollback()
	if _, err := store.CheckVaultRevisionTx(tx, id, expectedRevision); err != nil {
		return store.VaultNote{}, err
	}
	if _, err := store.UpsertVaultNoteTx(tx, id, string(summary), filename, epoch, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return store.VaultNote{}, err
	}
	operationID, err := randID()
	if err != nil {
		return store.VaultNote{}, err
	}
	operation := vaultFileOperation{ID: operationID, Action: fileOperationReplace, NoteID: id,
		StageName: stageRelative, TargetName: filename, ExpectedHash: notepkg.ContentHash(body)}
	if err := recordVaultFileOperation(tx, operation); err != nil {
		return store.VaultNote{}, err
	}
	if err := tx.Commit(); err != nil {
		return store.VaultNote{}, err
	}
	committed = true
	if err := a.completeVaultFileOperation(operation); err != nil {
		return store.VaultNote{}, err
	}
	return store.GetVaultNote(a.db, id)
}

func (a *app) deleteVaultNote(id string, expectedRevision int64) error {
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := store.CheckVaultRevisionTx(tx, id, expectedRevision); err != nil {
		return err
	}
	var filename string
	if err := tx.QueryRow("SELECT filename FROM vault_notes WHERE id = ?", id).Scan(&filename); err != nil {
		return err
	}
	if _, err := store.DeleteVaultNoteTx(tx, id); err != nil {
		return err
	}
	operationID, err := randID()
	if err != nil {
		return err
	}
	operation := vaultFileOperation{ID: operationID, Action: fileOperationDelete,
		NoteID: id, TargetName: filename}
	if err := recordVaultFileOperation(tx, operation); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return a.completeVaultFileOperation(operation)
}
