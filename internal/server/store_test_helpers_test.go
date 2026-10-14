package server

import (
	"database/sql"
	"time"

	"vylk/internal/store"
)

var (
	openDB                          = store.OpenDB
	initDB                          = store.InitDB
	getPrefs                        = store.GetPrefs
	savePrefs                       = store.SavePrefs
	listNotes                       = store.ListNotes
	listNotesPage                   = store.ListNotesPage
	searchNotes                     = store.SearchNotes
	listSyncChanges                 = store.ListSyncChanges
	getNote                         = store.GetNote
	listTags                        = store.ListTags
	decodeNoteCursor                = store.DecodeNoteCursor
	pruneMigrationBackups           = store.PruneMigrationBackups
	migrateRepairSyncOperationStats = store.MigrateRepairSyncOperationStats
	errInvalidCursor                = store.ErrInvalidCursor
	migrations                      = store.Migrations
)

const maxMigrationBackups = store.MaxMigrationBackups

func upsertNote(db *sql.DB, id, title, filename, tags string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := store.UpsertNoteTx(tx, id, title, filename, tags, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteNote(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := store.DeleteNoteTx(tx, id, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	return tx.Commit()
}
