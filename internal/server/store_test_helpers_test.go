package server

import "vylk/internal/store"

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
	upsertNote                      = store.UpsertNote
	deleteNote                      = store.DeleteNote
	listTags                        = store.ListTags
	decodeNoteCursor                = store.DecodeNoteCursor
	pruneMigrationBackups           = store.PruneMigrationBackups
	migrateRepairSyncOperationStats = store.MigrateRepairSyncOperationStats
	errInvalidCursor                = store.ErrInvalidCursor
	migrations                      = store.Migrations
)

const maxMigrationBackups = store.MaxMigrationBackups
