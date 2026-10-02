package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const (
	VaultPreparing = "preparing"
	VaultCleaning  = "cleaning"
	VaultReady     = "encrypted"
)

type VaultConfig struct {
	Mode               string
	VaultID            string
	KDFSalt            string
	KDFMemoryKiB       int
	KDFIterations      int
	AuthHash           []byte
	RecoveryHash       []byte
	WrappedKey         string
	WrappedRecoveryKey string
	Epoch              int64
	BackupPath         string
	BackupReady        bool
}

func GetVaultConfig(db *sql.DB) (*VaultConfig, error) {
	var config VaultConfig
	err := db.QueryRow(`SELECT mode, vault_id, kdf_salt, kdf_memory_kib, kdf_iterations,
		auth_hash, recovery_hash, wrapped_key, wrapped_recovery_key, epoch, backup_path, backup_ready
		FROM vault_config WHERE id = 1`).Scan(
		&config.Mode, &config.VaultID, &config.KDFSalt, &config.KDFMemoryKiB,
		&config.KDFIterations, &config.AuthHash, &config.RecoveryHash,
		&config.WrappedKey, &config.WrappedRecoveryKey, &config.Epoch, &config.BackupPath, &config.BackupReady,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read vault config: %w", err)
	}
	return &config, nil
}

type VaultNote struct {
	ID        string `json:"id"`
	Summary   string `json:"summary"`
	Filename  string `json:"-"`
	Pinned    bool   `json:"pinned"`
	PinOrder  int64  `json:"pin_order"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Revision  int64  `json:"revision"`
	Epoch     int64  `json:"epoch"`
}

func ScanVaultNote(row interface{ Scan(...any) error }) (VaultNote, error) {
	var note VaultNote
	err := row.Scan(&note.ID, &note.Summary, &note.Filename, &note.Pinned,
		&note.PinOrder, &note.CreatedAt, &note.UpdatedAt, &note.Revision, &note.Epoch)
	return note, err
}

func GetVaultNote(db *sql.DB, id string) (VaultNote, error) {
	return ScanVaultNote(db.QueryRow(`SELECT id, summary, filename, pinned, pin_order,
		created_at, updated_at, revision, epoch FROM vault_notes WHERE id = ?`, id))
}

func ListVaultNotes(db *sql.DB, cursorTime, cursorID string, limit int) ([]VaultNote, error) {
	if limit < 1 || limit > 501 {
		return nil, errors.New("invalid vault note page limit")
	}
	rows, err := db.Query(`SELECT id, summary, filename, pinned, pin_order,
		created_at, updated_at, revision, epoch FROM vault_notes
		WHERE (? = '' OR updated_at < ? OR (updated_at = ? AND id < ?))
		ORDER BY updated_at DESC, id DESC LIMIT ?`, cursorTime, cursorTime, cursorTime, cursorID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := make([]VaultNote, 0, limit)
	for rows.Next() {
		note, err := ScanVaultNote(rows)
		if err != nil {
			return nil, err
		}
		notes = append(notes, note)
	}
	return notes, rows.Err()
}

func CheckVaultRevisionTx(tx *sql.Tx, id string, expected int64) (int64, error) {
	var revision int64
	err := tx.QueryRow("SELECT revision FROM vault_notes WHERE id = ?", id).Scan(&revision)
	if errors.Is(err, sql.ErrNoRows) {
		return CheckNoteRevisionTx(tx, id, expected)
	}
	if err != nil {
		return 0, err
	}
	if revision != expected {
		return revision, ErrRevisionConflict
	}
	return revision, nil
}

func UpsertVaultNoteTx(tx *sql.Tx, id, summary, filename string, epoch int64, now string) (int64, error) {
	var previousRevision int64
	err := tx.QueryRow("SELECT revision FROM vault_notes WHERE id = ?", id).Scan(&previousRevision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.QueryRow("SELECT COALESCE(MAX(revision), 0) FROM sync_changes WHERE note_id = ?", id).Scan(&previousRevision); err != nil {
			return 0, err
		}
	}
	revision := previousRevision + 1
	_, err = tx.Exec(`INSERT INTO vault_notes
		(id, summary, filename, created_at, updated_at, revision, epoch)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, filename = excluded.filename,
			updated_at = excluded.updated_at, revision = excluded.revision, epoch = excluded.epoch`,
		id, summary, filename, now, now, revision, epoch)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 0, ?)", id, revision, now); err != nil {
		return 0, err
	}
	return revision, CompactSyncChangesTx(tx)
}

func DeleteVaultNoteTx(tx *sql.Tx, id string) (int64, error) {
	var revision int64
	if err := tx.QueryRow("SELECT revision FROM vault_notes WHERE id = ?", id).Scan(&revision); err != nil {
		return 0, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 1, ?)", id, revision+1, now); err != nil {
		return 0, err
	}
	if _, err := tx.Exec("DELETE FROM vault_notes WHERE id = ?", id); err != nil {
		return 0, err
	}
	return revision + 1, CompactSyncChangesTx(tx)
}
