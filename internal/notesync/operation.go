package notesync

import (
	"errors"
	"regexp"

	"vylk/internal/note"
	"vylk/internal/preference"
)

const MaxPushBytes = 4 << 20

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type PushRequest struct {
	DeviceID   string      `json:"device_id"`
	Operations []Operation `json:"operations"`
}

type Operation struct {
	ClientSequence int64                   `json:"client_sequence"`
	OpID           string                  `json:"op_id"`
	Type           string                  `json:"type"`
	NoteID         string                  `json:"note_id,omitempty"`
	BaseRevision   *int64                  `json:"base_revision,omitempty"`
	Title          string                  `json:"title,omitempty"`
	Tags           string                  `json:"tags,omitempty"`
	Content        string                  `json:"content,omitempty"`
	BaseContent    string                  `json:"base_content,omitempty"`
	Pinned         bool                    `json:"pinned,omitempty"`
	Prefs          *preference.Preferences `json:"prefs,omitempty"`
}

type OperationResult struct {
	ClientSequence  int64  `json:"client_sequence"`
	OpID            string `json:"op_id"`
	Status          string `json:"status"`
	Revision        int64  `json:"revision,omitempty"`
	CurrentRevision int64  `json:"current_revision,omitempty"`
	PinOrder        int64  `json:"pin_order,omitempty"`
}

type PushResponse struct {
	Acknowledged     []OperationResult `json:"acknowledged"`
	ExpectedSequence int64             `json:"expected_sequence"`
}

func ValidIdentifier(value string) bool { return identifierPattern.MatchString(value) }

func Validate(operation Operation) error {
	if operation.ClientSequence < 1 || !ValidIdentifier(operation.OpID) {
		return errors.New("invalid sync operation")
	}
	switch operation.Type {
	case "note.save":
		if !note.ValidID(operation.NoteID) || operation.BaseRevision == nil || len(operation.Title) > note.MaxTitleBytes || len(operation.Tags) > note.MaxTagsBytes {
			return errors.New("invalid note save operation")
		}
	case "note.delete":
		if !note.ValidID(operation.NoteID) || operation.BaseRevision == nil || *operation.BaseRevision < 1 {
			return errors.New("invalid note delete operation")
		}
	case "note.pin":
		if !note.ValidID(operation.NoteID) || operation.BaseRevision == nil || *operation.BaseRevision < 0 {
			return errors.New("invalid note pin operation")
		}
	case "prefs.save":
		if operation.Prefs == nil || preference.Validate(operation.Prefs) != nil || preference.ValidatePatch(operation.Prefs.SyncPatch) != nil {
			return errors.New("invalid preferences operation")
		}
	case "noop":
	default:
		return errors.New("unknown sync operation")
	}
	return nil
}
