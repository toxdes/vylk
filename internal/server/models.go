package server

import (
	notepkg "vylk/internal/note"
	"vylk/internal/notesync"
	"vylk/internal/preference"
)

// prefs keeps transport declarations compact while the owning model and all
// of its behavior remain in the preference package.
type prefs = preference.Preferences
type note = notepkg.Note
type syncPushRequest = notesync.PushRequest
type syncOperationRequest = notesync.Operation
type syncOperationResult = notesync.OperationResult
type syncPushResponse = notesync.PushResponse
