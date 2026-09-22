package store

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"vylk/internal/note"
	"vylk/internal/notesync"
	"vylk/internal/preference"
)

func GetPrefs(db *sql.DB) (*preference.Preferences, error) {
	dbTx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer dbTx.Rollback()
	p, err := GetPrefsTx(dbTx)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func GetPrefsTx(tx *sql.Tx) (*preference.Preferences, error) {
	var data string
	var revision int64
	if err := tx.QueryRow("SELECT data, revision FROM prefs WHERE id = 1").Scan(&data, &revision); err != nil {
		return nil, err
	}
	p := preference.Defaults()
	p.Revision = revision
	if err := json.Unmarshal([]byte(data), p); err != nil {
		return nil, fmt.Errorf("decode preferences: %w", err)
	}
	var legacy struct {
		HidePreview *bool `json:"hidePreview"`
	}
	if err := json.Unmarshal([]byte(data), &legacy); err != nil {
		return nil, fmt.Errorf("decode legacy preferences: %w", err)
	}
	if p.StartView == "" && legacy.HidePreview != nil && *legacy.HidePreview {
		p.StartView = "editor"
	}
	if p.StartView == "" {
		p.StartView = "split"
	}
	p.Revision = revision
	p.SyncPatch = nil
	p.SyncBase = nil
	return p, nil
}

func SavePrefsTx(tx *sql.Tx, p *preference.Preferences, expectedRevision *int64) error {
	current, err := GetPrefsTx(tx)
	if err != nil {
		return err
	}
	if expectedRevision != nil && *expectedRevision != current.Revision {
		return ErrRevisionConflict
	}
	stored := *p
	stored.Revision = 0
	stored.SyncPatch = nil
	stored.SyncBase = nil
	b, err := json.Marshal(&stored)
	if err != nil {
		return err
	}
	nextRevision := current.Revision + 1
	if _, err := tx.Exec("UPDATE prefs SET data = ?, revision = ? WHERE id = 1", string(b), nextRevision); err != nil {
		return err
	}
	p.Revision = nextRevision
	return nil
}

func SavePrefs(db *sql.DB, p *preference.Preferences, expectedRevision *int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := SavePrefsTx(tx, p, expectedRevision); err != nil {
		return err
	}
	return tx.Commit()
}

func ListNotes(db *sql.DB, tag string) ([]note.Note, error) {
	var rows *sql.Rows
	var err error
	if tag != "" {
		rows, err = db.Query(`
			SELECT n.id, n.title, n.filename, n.tags, n.pinned, n.pin_order, n.created_at, n.updated_at, n.revision
			FROM notes n
			JOIN note_tags nt ON nt.note_id = n.id
			WHERE nt.tag = ?
			ORDER BY n.updated_at DESC`, tag)
	} else {
		rows, err = db.Query("SELECT id, title, filename, tags, pinned, pin_order, created_at, updated_at, revision FROM notes ORDER BY updated_at DESC")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	notes := make([]note.Note, 0)
	for rows.Next() {
		var n note.Note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.Pinned, &n.PinOrder, &n.CreatedAt, &n.UpdatedAt, &n.Revision); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func EncodeNoteCursor(n note.Note) string {
	return base64.RawURLEncoding.EncodeToString([]byte(n.UpdatedAt + "\x00" + n.ID))
}

func DecodeNoteCursor(cursor string) (updatedAt, id string, err error) {
	data, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", ErrInvalidCursor
	}
	updatedAt, id, ok := strings.Cut(string(data), "\x00")
	if !ok || updatedAt == "" || id == "" {
		return "", "", ErrInvalidCursor
	}
	return updatedAt, id, nil
}

func ListNotesPage(db *sql.DB, tag, cursor string, limit int) (note.Page, error) {
	if limit < 1 || limit > 100 {
		return note.Page{}, fmt.Errorf("invalid page limit")
	}

	var updatedAt, id string
	var err error
	if cursor != "" {
		updatedAt, id, err = DecodeNoteCursor(cursor)
		if err != nil {
			return note.Page{}, err
		}
	}

	query := "SELECT n.id, n.title, n.filename, n.tags, n.pinned, n.pin_order, n.created_at, n.updated_at, n.revision FROM notes n"
	args := make([]any, 0, 4)
	where := make([]string, 0, 2)
	if tag != "" {
		query += " JOIN note_tags nt ON nt.note_id = n.id"
		where = append(where, "nt.tag = ?")
		args = append(args, tag)
	}
	if cursor != "" {
		where = append(where, "(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))")
		args = append(args, updatedAt, updatedAt, id)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY n.updated_at DESC, n.id DESC LIMIT ?"
	args = append(args, limit+1)

	rows, err := db.Query(query, args...)
	if err != nil {
		return note.Page{}, err
	}
	defer rows.Close()

	page := note.Page{Notes: make([]note.Note, 0, limit)}
	for rows.Next() {
		var n note.Note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.Pinned, &n.PinOrder, &n.CreatedAt, &n.UpdatedAt, &n.Revision); err != nil {
			return note.Page{}, err
		}
		page.Notes = append(page.Notes, n)
	}
	if err := rows.Err(); err != nil {
		return note.Page{}, err
	}
	if len(page.Notes) > limit {
		page.Notes = page.Notes[:limit]
		page.NextCursor = EncodeNoteCursor(page.Notes[len(page.Notes)-1])
	}
	return page, nil
}

func SearchNotes(db *sql.DB, query string, limit int) ([]note.Note, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("invalid search limit")
	}
	match := MetadataSearchQuery(query)
	if match == "" {
		return []note.Note{}, nil
	}
	rows, err := db.Query(`
		SELECT n.id, n.title, n.filename, n.tags, n.pinned, n.pin_order, n.created_at, n.updated_at, n.revision
		FROM note_metadata_fts
		JOIN notes n ON n.id = note_metadata_fts.note_id
		WHERE note_metadata_fts MATCH ?
		ORDER BY bm25(note_metadata_fts), n.updated_at DESC
		LIMIT ?`, match, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var notes []note.Note
	for rows.Next() {
		var n note.Note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.Pinned, &n.PinOrder, &n.CreatedAt, &n.UpdatedAt, &n.Revision); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func ListSyncChanges(db *sql.DB, since int64, limit int) (notesync.ChangesPage, error) {
	var oldest, newest sql.NullInt64
	if err := db.QueryRow("SELECT MIN(sequence), MAX(sequence) FROM sync_changes").Scan(&oldest, &newest); err != nil {
		return notesync.ChangesPage{}, err
	}
	if oldest.Valid && since < oldest.Int64-1 {
		return notesync.ChangesPage{Changes: []notesync.Change{}, NextSequence: newest.Int64, ResetRequired: true}, nil
	}
	rows, err := db.Query(`
		SELECT sequence, note_id, revision, deleted, changed_at
		FROM sync_changes
		WHERE sequence > ?
		ORDER BY sequence
		LIMIT ?`, since, limit+1)
	if err != nil {
		return notesync.ChangesPage{}, err
	}
	defer rows.Close()

	page := notesync.ChangesPage{Changes: make([]notesync.Change, 0, limit), NextSequence: since}
	for rows.Next() {
		var change notesync.Change
		var deleted int
		if err := rows.Scan(&change.Sequence, &change.NoteID, &change.Revision, &deleted, &change.ChangedAt); err != nil {
			return notesync.ChangesPage{}, err
		}
		if len(page.Changes) == limit {
			page.HasMore = true
			break
		}
		change.Deleted = deleted != 0
		page.Changes = append(page.Changes, change)
		page.NextSequence = change.Sequence
	}
	if err := rows.Err(); err != nil {
		return notesync.ChangesPage{}, err
	}
	return page, nil
}

func MetadataSearchQuery(raw string) string {
	words := strings.Fields(raw)
	if len(words) > 8 {
		words = words[:8]
	}
	quoted := make([]string, 0, len(words))
	for _, word := range words {
		word = strings.ReplaceAll(word, `"`, `""`)
		if word != "" {
			quoted = append(quoted, `"`+word+`"`+"*")
		}
	}
	return strings.Join(quoted, " AND ")
}

type rowQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

func getNote(queryer rowQuerier, id string) (*note.Note, error) {
	var n note.Note
	err := queryer.QueryRow(
		"SELECT id, title, filename, tags, pinned, pin_order, created_at, updated_at, revision FROM notes WHERE id = ?", id,
	).Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.Pinned, &n.PinOrder, &n.CreatedAt, &n.UpdatedAt, &n.Revision)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func GetNote(db *sql.DB, id string) (*note.Note, error) {
	return getNote(db, id)
}

func GetNoteTx(tx *sql.Tx, id string) (*note.Note, error) {
	return getNote(tx, id)
}

// CurrentNoteRevision returns the live revision, or the newest tombstone
// revision when the note has been deleted.
func CurrentNoteRevision(queryer rowQuerier, id string) (int64, error) {
	n, err := getNote(queryer, id)
	if err == nil {
		return n.Revision, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var revision int64
	err = queryer.QueryRow("SELECT COALESCE(MAX(revision), 0) FROM sync_changes WHERE note_id = ?", id).Scan(&revision)
	return revision, err
}

// CheckNoteRevisionTx validates a live note revision. A deleted note always
// conflicts, including when the client still holds its pre-deletion revision.
func CheckNoteRevisionTx(tx *sql.Tx, id string, expected int64) (int64, error) {
	n, err := getNote(tx, id)
	if err == nil {
		if n.Revision != expected {
			return n.Revision, ErrRevisionConflict
		}
		return n.Revision, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	revision, err := CurrentNoteRevision(tx, id)
	if err != nil {
		return 0, err
	}
	if expected != 0 || revision != 0 {
		return revision, ErrRevisionConflict
	}
	return 0, nil
}

func NextPinOrderTx(tx *sql.Tx) (int64, error) {
	var order int64
	err := tx.QueryRow("SELECT COALESCE(MAX(pin_order), 0) + 1 FROM notes WHERE pinned = 1").Scan(&order)
	return order, err
}

func UpsertNote(db *sql.DB, id, title, filename, tags string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := UpsertNoteTx(tx, id, title, filename, tags, now); err != nil {
		return err
	}
	return tx.Commit()
}

func UpsertNoteTx(tx *sql.Tx, id, title, filename, tags, now string) error {
	_, err := tx.Exec(`
		INSERT INTO notes (id, title, filename, tags, created_at, updated_at, revision)
		VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revision) + 1 FROM sync_changes WHERE note_id = ?), 1))
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title,
			filename=excluded.filename,
			tags=excluded.tags,
			updated_at=excluded.updated_at,
			revision=notes.revision + 1
	`, id, title, filename, tags, now, now, id)
	if err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM note_metadata_fts WHERE note_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO note_metadata_fts (note_id, title, tags) VALUES (?, ?, ?)", id, title, tags); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM note_tags WHERE note_id = ?", id); err != nil {
		return err
	}
	for _, tag := range ParseTags(tags) {
		if _, err := tx.Exec("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)", id, tag); err != nil {
			return err
		}
	}
	var revision int64
	if err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", id).Scan(&revision); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 0, ?)", id, revision, now); err != nil {
		return err
	}
	return CompactSyncChangesTx(tx)
}

func DeleteNote(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := DeleteNoteTx(tx, id, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	return tx.Commit()
}

func DeleteNoteTx(tx *sql.Tx, id, now string) error {
	var revision int64
	if err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", id).Scan(&revision); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 1, ?)", id, revision+1, now); err != nil {
		return err
	}
	if err := CompactSyncChangesTx(tx); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM note_metadata_fts WHERE note_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM notes WHERE id = ?", id); err != nil {
		return err
	}
	return nil
}

func CompactSyncChangesTx(tx *sql.Tx) error {
	var newest sql.NullInt64
	if err := tx.QueryRow("SELECT MAX(sequence) FROM sync_changes").Scan(&newest); err != nil {
		return err
	}
	if !newest.Valid || newest.Int64 <= maxSyncChanges {
		return nil
	}
	_, err := tx.Exec("DELETE FROM sync_changes WHERE sequence <= ?", newest.Int64-maxSyncChanges)
	return err
}

func ListTags(db *sql.DB) ([]string, error) {
	rows, err := db.Query("SELECT DISTINCT tag FROM note_tags ORDER BY tag COLLATE NOCASE")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		result = append(result, tag)
	}
	return result, rows.Err()
}

func ParseTags(s string) []string {
	if s == "" {
		return nil
	}
	var tags []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			tag := s[start:i]
			if tag != "" {
				tags = append(tags, tag)
			}
			start = i + 1
		}
	}
	return tags
}
