// Package notesync owns the durable synchronization protocol and its state
// representations.
package notesync

type Change struct {
	Sequence  int64  `json:"sequence"`
	NoteID    string `json:"note_id"`
	Revision  int64  `json:"revision"`
	Deleted   bool   `json:"deleted"`
	ChangedAt string `json:"changed_at"`
}

type ChangesPage struct {
	Changes       []Change `json:"changes"`
	NextSequence  int64    `json:"nextSequence"`
	HasMore       bool     `json:"hasMore"`
	ResetRequired bool     `json:"resetRequired,omitempty"`
}
