// Package store owns Vylk's SQLite schema and persistence operations.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrInvalidCursor = errors.New("invalid cursor")
var ErrRevisionConflict = errors.New("revision conflict")

const MaxMigrationBackups = 3
const maxSyncChanges = 100000

func OpenDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-8000")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

type Migration struct {
	Version int
	Up      func(*sql.Tx) error
}

var Migrations = []Migration{
	{Version: 1, Up: migrateInitialSchema},
	{Version: 2, Up: migrateTagIndex},
	{Version: 3, Up: migrateRateLimitSchema},
	{Version: 4, Up: migrateRemoveUnusedTagIndex},
	{Version: 5, Up: migrateMetadataSearch},
	{Version: 6, Up: migrateSyncSchema},
	{Version: 7, Up: migrateSessionSchema},
	{Version: 8, Up: migrateSyncOperationsSchema},
	{Version: 9, Up: migrateSyncOperationPayloadSchema},
	{Version: 10, Up: migrateFileOperationSchema},
	{Version: 11, Up: migrateClearLegacyIPBans},
	{Version: 12, Up: migrateFileOperationHashSchema},
	{Version: 13, Up: migrateFileOperationRecoverySchema},
	{Version: 14, Up: migrateSyncOperationCompactionSchema},
	{Version: 15, Up: migratePreferenceRevisionSchema},
	{Version: 16, Up: MigrateRepairSyncOperationStats},
	{Version: 17, Up: migrateNotePinningSchema},
	{Version: 18, Up: migrateInstanceMetadataSchema},
}

func InitDB(db *sql.DB, databasePaths ...string) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return err
	}
	pending, err := PendingMigrations(db)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}
	if len(databasePaths) > 0 {
		backupPath, err := BackupBeforeMigration(db, databasePaths[0], pending[0].Version)
		if err != nil {
			return fmt.Errorf("backup before migration %d: %w", pending[0].Version, err)
		}
		if backupPath != "" {
			log.Printf("created pre-migration database backup: %s", backupPath)
		}
	}
	for _, migration := range pending {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if err := migration.Up(tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", migration.Version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.Version, time.Now().UTC().Format(time.RFC3339)); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %d: %w", migration.Version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", migration.Version, err)
		}
	}
	return nil
}

func migrateInstanceMetadataSchema(tx *sql.Tx) error {
	instanceID, err := newInstanceID()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`
		CREATE TABLE instance_metadata (
			id         INTEGER PRIMARY KEY CHECK (id = 1),
			instance_id TEXT NOT NULL
		);
		INSERT INTO instance_metadata (id, instance_id) VALUES (1, ?);`, instanceID); err != nil {
		return err
	}
	return nil
}

func newInstanceID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func InstanceID(db *sql.DB) (string, error) {
	var instanceID string
	if err := db.QueryRow("SELECT instance_id FROM instance_metadata WHERE id = 1").Scan(&instanceID); err != nil {
		return "", err
	}
	return instanceID, nil
}

func PendingMigrations(db *sql.DB) ([]Migration, error) {
	pending := make([]Migration, 0)
	for _, migration := range Migrations {
		var version int
		err := db.QueryRow("SELECT version FROM schema_migrations WHERE version = ?", migration.Version).Scan(&version)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		pending = append(pending, migration)
	}
	return pending, nil
}

func BackupBeforeMigration(db *sql.DB, databasePath string, version int) (string, error) {
	if databasePath == "" || databasePath == ":memory:" {
		return "", nil
	}
	var userTableCount int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')`).Scan(&userTableCount); err != nil {
		return "", err
	}
	if userTableCount == 0 {
		return "", nil
	}

	directory := filepath.Dir(databasePath)
	base := filepath.Base(databasePath)
	backupPath := filepath.Join(directory, fmt.Sprintf("%s.pre-migration-v%d-%s.db", base, version, time.Now().UTC().Format("20060102T150405.000000000Z")))
	info, err := os.Stat(databasePath)
	if err != nil {
		return "", err
	}
	if _, err := db.Exec("VACUUM INTO ?", backupPath); err != nil {
		return "", fmt.Errorf("create consistent backup (requires roughly %d additional bytes of disk space): %w", info.Size(), err)
	}
	if err := os.Chmod(backupPath, 0600); err != nil {
		return "", err
	}
	if err := PruneMigrationBackups(directory, base); err != nil {
		return "", err
	}
	return backupPath, nil
}

func PruneMigrationBackups(directory, base string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	prefix := base + ".pre-migration-v"
	type backupFile struct {
		name    string
		modTime time.Time
	}
	backups := make([]backupFile, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || !strings.HasSuffix(entry.Name(), ".db") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		backups = append(backups, backupFile{name: entry.Name(), modTime: info.ModTime()})
	}
	sort.Slice(backups, func(i, j int) bool {
		if backups[i].modTime.Equal(backups[j].modTime) {
			return backups[i].name > backups[j].name
		}
		return backups[i].modTime.After(backups[j].modTime)
	})
	if len(backups) > MaxMigrationBackups {
		for _, backup := range backups[MaxMigrationBackups:] {
			if err := os.Remove(filepath.Join(directory, backup.name)); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrateInitialSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id        TEXT PRIMARY KEY,
			title     TEXT NOT NULL DEFAULT '',
			filename  TEXT NOT NULL UNIQUE,
			tags      TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS prefs (
			id    INTEGER PRIMARY KEY DEFAULT 1,
			data  TEXT NOT NULL DEFAULT '{}'
		);
		INSERT OR IGNORE INTO prefs (id, data) VALUES (1, '{"autoSave":true}');
	`)
	return err
}

func migrateNotePinningSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
		ALTER TABLE notes ADD COLUMN pin_order INTEGER NOT NULL DEFAULT 0;
		CREATE INDEX IF NOT EXISTS idx_notes_pin_order ON notes(pinned, pin_order);`)
	return err
}

func migrateTagIndex(tx *sql.Tx) error {
	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS note_tags (
			note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			tag     TEXT NOT NULL,
			PRIMARY KEY (note_id, tag)
		);
		CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag, note_id);`); err != nil {
		return err
	}
	rows, err := tx.Query(`
		SELECT n.id, n.tags
		FROM notes n
		WHERE n.tags != ''
		  AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)`)
	if err != nil {
		return err
	}
	var records []struct{ id, tags string }
	for rows.Next() {
		var record struct{ id, tags string }
		if err := rows.Scan(&record.id, &record.tags); err != nil {
			rows.Close()
			return err
		}
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, record := range records {
		for _, tag := range ParseTags(record.tags) {
			if _, err := tx.Exec("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)", record.id, tag); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrateRateLimitSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS ip_bans (
			ip        TEXT PRIMARY KEY,
			reason    TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS rate_limits (
			ip        TEXT NOT NULL,
			typ       TEXT NOT NULL,
			count     INTEGER NOT NULL DEFAULT 1,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (ip, typ)
		);`)
	return err
}

// Earlier releases made both failed-login and missing-asset bans permanent.
// A stale service-worker request could therefore lock a legitimate user out.
// Rate limiting is now in-memory and temporary, so clear the legacy state.
func migrateClearLegacyIPBans(tx *sql.Tx) error {
	_, err := tx.Exec("DELETE FROM ip_bans; DELETE FROM rate_limits")
	return err
}

func migrateRemoveUnusedTagIndex(tx *sql.Tx) error {
	_, err := tx.Exec("DROP INDEX IF EXISTS idx_notes_tags")
	return err
}

func migrateMetadataSearch(tx *sql.Tx) error {
	if _, err := tx.Exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS note_metadata_fts USING fts5(
			note_id UNINDEXED,
			title,
			tags
		);`); err != nil {
		return err
	}
	rows, err := tx.Query("SELECT id, title, tags FROM notes")
	if err != nil {
		return err
	}
	type searchRecord struct{ id, title, tags string }
	var records []searchRecord
	for rows.Next() {
		var record searchRecord
		if err := rows.Scan(&record.id, &record.title, &record.tags); err != nil {
			rows.Close()
			return err
		}
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, record := range records {
		if _, err := tx.Exec("INSERT INTO note_metadata_fts (note_id, title, tags) VALUES (?, ?, ?)", record.id, record.title, record.tags); err != nil {
			return err
		}
	}
	return nil
}

func migrateSyncSchema(tx *sql.Tx) error {
	if _, err := tx.Exec(`ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		CREATE TABLE sync_changes (
			sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id    TEXT NOT NULL,
			revision   INTEGER NOT NULL,
			deleted    INTEGER NOT NULL DEFAULT 0,
			changed_at TEXT NOT NULL
		);
		CREATE INDEX idx_sync_changes_sequence ON sync_changes(sequence);
		INSERT INTO sync_changes (note_id, revision, deleted, changed_at)
		SELECT id, revision, 0, updated_at FROM notes;`); err != nil {
		return err
	}
	return nil
}

func migrateSessionSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE sessions (
			token_hash TEXT PRIMARY KEY,
			expires_at TEXT NOT NULL
		);
		CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);`)
	return err
}

func migrateSyncOperationsSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE sync_device_state (
			device_id     TEXT PRIMARY KEY,
			last_sequence INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE sync_operations (
			device_id      TEXT NOT NULL,
			client_sequence INTEGER NOT NULL,
			op_id          TEXT NOT NULL,
			op_type        TEXT NOT NULL,
			result         TEXT NOT NULL,
			applied_at     TEXT NOT NULL,
			PRIMARY KEY (device_id, client_sequence),
			UNIQUE (device_id, op_id)
		);`)
	return err
}

func migrateSyncOperationPayloadSchema(tx *sql.Tx) error {
	_, err := tx.Exec("ALTER TABLE sync_operations ADD COLUMN operation TEXT NOT NULL DEFAULT '{}'")
	return err
}

func migrateFileOperationSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE file_operations (
			id         TEXT PRIMARY KEY,
			action     TEXT NOT NULL,
			note_id    TEXT NOT NULL,
			stage_name TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		);
		CREATE INDEX idx_file_operations_created_at ON file_operations(created_at);`)
	return err
}

func migrateFileOperationHashSchema(tx *sql.Tx) error {
	_, err := tx.Exec("ALTER TABLE file_operations ADD COLUMN expected_hash TEXT NOT NULL DEFAULT ''")
	return err
}

func migrateFileOperationRecoverySchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		ALTER TABLE file_operations ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
		ALTER TABLE file_operations ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
		ALTER TABLE file_operations ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;`)
	return err
}

func migrateSyncOperationCompactionSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE sync_operation_stats (
			id              INTEGER PRIMARY KEY CHECK (id = 1),
			operation_count INTEGER NOT NULL DEFAULT 0,
			payload_bytes   INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO sync_operation_stats (id, operation_count, payload_bytes)
		SELECT 1, COUNT(*), COALESCE(SUM(length(operation)), 0) FROM sync_operations;
		CREATE INDEX idx_sync_operations_applied_at ON sync_operations(applied_at, device_id, client_sequence);`)
	return err
}

func migratePreferenceRevisionSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`ALTER TABLE prefs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`)
	return err
}

func MigrateRepairSyncOperationStats(tx *sql.Tx) error {
	_, err := tx.Exec(`UPDATE sync_operation_stats
		SET operation_count = (SELECT COUNT(*) FROM sync_operations),
		    payload_bytes = (SELECT COALESCE(SUM(length(operation)), 0) FROM sync_operations)
		WHERE id = 1`)
	return err
}
