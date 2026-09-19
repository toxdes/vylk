package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"vylk/internal/httpx"
)

const maxNoteRequestBytes = 4 << 20 // 4 MiB

const (
	maxTitleBytes = 512
	maxTagsBytes  = 4 << 10
)

var noteIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var errRevisionConflict = errors.New("note revision conflict")

func randID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func sanitizePath(base, path string) (string, error) {
	abs, err := filepath.Abs(filepath.Join(base, path))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", http.ErrMissingFile
	}
	return abs, nil
}

func writeNoteFile(path string, content []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".vylk-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func normalizeTags(raw string) string {
	parts := strings.Split(raw, ",")
	cleaned := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		tag := strings.TrimSpace(part)
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		cleaned = append(cleaned, tag)
	}
	return strings.Join(cleaned, ",")
}

func (a *app) handleListNotes(w http.ResponseWriter, r *http.Request) {
	tag := r.URL.Query().Get("tag")
	limitParam := r.URL.Query().Get("limit")
	if limitParam != "" {
		limit, err := strconv.Atoi(limitParam)
		if err != nil || limit < 1 || limit > 100 {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_page_limit", "invalid page limit")
			return
		}
		page, err := listNotesPage(a.db, tag, r.URL.Query().Get("cursor"), limit)
		if err != nil {
			if errors.Is(err, errInvalidCursor) {
				httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_cursor", "invalid cursor")
				return
			}
			httpx.WriteAPIError(w, http.StatusInternalServerError, "list_notes_failed", "could not list notes")
			return
		}
		httpx.WriteJSON(w, page)
		return
	}
	notes, err := listNotes(a.db, tag)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "list_notes_failed", "could not list notes")
		return
	}
	httpx.WriteJSON(w, notes)
}

func (a *app) handleSearchNotes(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 256 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "search_query_too_long", "search query is too long")
		return
	}
	notes, err := searchNotes(a.db, query, 50)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "search_failed", "could not search notes")
		return
	}
	httpx.WriteJSON(w, notes)
}

func (a *app) handleSyncChanges(w http.ResponseWriter, r *http.Request) {
	since := int64(0)
	if raw := r.URL.Query().Get("since"); raw != "" {
		var err error
		since, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || since < 0 {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_sync_sequence", "invalid sync sequence")
			return
		}
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 500 {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_page_limit", "invalid page limit")
			return
		}
	}
	page, err := listSyncChanges(a.db, since, limit)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "list_sync_changes_failed", "could not list sync changes")
		return
	}
	httpx.WriteJSON(w, page)
}

func (a *app) handleGetNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	data, err := a.loadNoteWithContent(id)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "load_note_failed", "could not load note")
			return
		}
		httpx.WriteAPIError(w, http.StatusNotFound, "note_not_found", "not found")
		return
	}
	httpx.WriteJSON(w, data)
}

type noteWithContent struct {
	note
	Content string `json:"content"`
}

func (a *app) loadNoteWithContent(id string) (noteWithContent, error) {
	a.noteMu.Lock()
	defer a.noteMu.Unlock()

	n, err := getNote(a.db, id)
	if err != nil {
		return noteWithContent{}, err
	}
	if cached, ok := a.noteCache.get(id); ok {
		return noteWithContent{
			note:    *n,
			Content: cached,
		}, nil
	}
	path, err := sanitizePath(a.notesDir, n.Filename)
	if err != nil {
		return noteWithContent{}, err
	}
	enc, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return noteWithContent{}, sql.ErrNoRows
		}
		return noteWithContent{}, fmt.Errorf("read note file: %w", err)
	}
	plain, err := a.encryption.decryptNote(enc, id)
	if err != nil {
		return noteWithContent{}, err
	}
	content := string(plain)
	a.noteCache.set(id, content)
	return noteWithContent{
		note:    *n,
		Content: content,
	}, nil
}

func (a *app) handleBulkGetNotes(w http.ResponseWriter, r *http.Request) {
	const maxBulkNotes = 25
	rawIDs := strings.Split(r.URL.Query().Get("ids"), ",")
	if len(rawIDs) == 1 && rawIDs[0] == "" {
		httpx.WriteJSON(w, map[string]any{"notes": []noteWithContent{}, "missing": []string{}})
		return
	}
	if len(rawIDs) > maxBulkNotes {
		httpx.WriteAPIError(w, http.StatusBadRequest, "too_many_note_ids", "too many note ids")
		return
	}
	ids := make([]string, 0, len(rawIDs))
	seen := make(map[string]struct{}, len(rawIDs))
	for _, id := range rawIDs {
		if !noteIDPattern.MatchString(id) {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_note_id", "invalid note id")
			return
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}

	notes := make([]noteWithContent, 0, len(ids))
	missing := make([]string, 0)
	for _, id := range ids {
		data, err := a.loadNoteWithContent(id)
		if errors.Is(err, sql.ErrNoRows) {
			missing = append(missing, id)
			continue
		}
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "load_notes_failed", "could not load notes")
			return
		}
		notes = append(notes, data)
	}
	httpx.WriteJSON(w, map[string]any{"notes": notes, "missing": missing})
}

type saveRequest struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Content      string `json:"content"`
	Tags         string `json:"tags"`
	BaseRevision *int64 `json:"base_revision,omitempty"`
}

func currentNoteRevision(db *sql.DB, id string) (int64, error) {
	n, err := getNote(db, id)
	if err == nil {
		return n.Revision, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var latest int64
	if err := db.QueryRow("SELECT COALESCE(MAX(revision), 0) FROM sync_changes WHERE note_id = ?", id).Scan(&latest); err != nil {
		return 0, err
	}
	return latest, nil
}

func checkNoteRevision(db *sql.DB, id string, expected int64) error {
	latest, err := currentNoteRevision(db, id)
	if err != nil {
		return err
	}
	if latest != expected {
		return errRevisionConflict
	}
	return nil
}

func (a *app) writeNoteRevisionConflict(w http.ResponseWriter, noteID string) {
	revision, err := currentNoteRevision(a.db, noteID)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "read_note_revision_failed", "could not read current note revision")
		return
	}
	httpx.WriteJSONStatus(w, http.StatusConflict, map[string]any{
		"error":            "note changed on another device",
		"code":             "note_revision_conflict",
		"note_id":          noteID,
		"current_revision": revision,
	})
}

// prepareNoteFileOperation recovers interrupted work and prevents new writes
// to a note whose prior operation still needs manual recovery. Callers must
// hold noteMu so recovery and the following mutation remain serialized.
func (a *app) prepareNoteFileOperation(w http.ResponseWriter, noteID string) bool {
	if err := a.recoverFileOperations(); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "recover_file_operations_failed", "could not recover pending file operations")
		return false
	}
	blocked, err := a.fileOperationBlocked(noteID)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "inspect_file_operations_failed", "could not inspect pending file operations")
		return false
	}
	if !blocked {
		return true
	}
	httpx.WriteJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
		"error":   "note file recovery requires attention",
		"code":    "note_file_recovery_blocked",
		"note_id": noteID,
	})
	return false
}

func (a *app) handleSaveNote(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if !httpx.DecodeJSON(w, r, &req, maxNoteRequestBytes) {
		return
	}
	if len(req.Title) > maxTitleBytes || len(req.Tags) > maxTagsBytes {
		httpx.WriteAPIError(w, http.StatusBadRequest, "note_metadata_too_long", "title or tags are too long")
		return
	}

	id := req.ID
	if id == "" {
		var err error
		id, err = randID()
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "create_note_failed", "could not create note")
			return
		}
	} else if !noteIDPattern.MatchString(id) {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_note_id", "invalid note id")
		return
	} else if req.BaseRevision == nil {
		httpx.WriteJSONStatus(w, http.StatusBadRequest, map[string]any{
			"error": "base_revision is required for an existing note",
			"code":  "base_revision_required",
		})
		return
	}

	tags := normalizeTags(req.Tags)

	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if !a.prepareNoteFileOperation(w, id) {
		return
	}
	n, err := a.saveNoteWithFileOperation(id, req.Title, tags, req.Content, req.BaseRevision)
	if errors.Is(err, errRevisionConflict) {
		a.writeNoteRevisionConflict(w, id)
		return
	}
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "save_note_failed", "write failed")
		return
	}
	a.publishChange("notes")
	httpx.WriteJSON(w, n)
}

func (a *app) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var expectedRevision *int64
	if raw := r.URL.Query().Get("base_revision"); raw != "" {
		revision, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || revision < 1 {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_note_revision", "invalid note revision")
			return
		}
		expectedRevision = &revision
	} else {
		httpx.WriteJSONStatus(w, http.StatusBadRequest, map[string]any{
			"error": "base_revision is required for deletion",
			"code":  "base_revision_required",
		})
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if !a.prepareNoteFileOperation(w, id) {
		return
	}
	err := a.deleteNoteWithFileOperation(id, expectedRevision)
	if errors.Is(err, errRevisionConflict) {
		a.writeNoteRevisionConflict(w, id)
		return
	}
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "delete_note_failed", "delete failed")
			return
		}
		httpx.WriteAPIError(w, http.StatusNotFound, "note_not_found", "not found")
		return
	}
	a.publishChange("notes")
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleListTags(w http.ResponseWriter, r *http.Request) {
	tags, err := listTags(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "list_tags_failed", "could not list tags")
		return
	}
	if tags == nil {
		tags = []string{}
	}
	httpx.WriteJSON(w, tags)
}

func (a *app) handleGetPrefs(w http.ResponseWriter, r *http.Request) {
	p, err := getPrefs(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "load_preferences_failed", "could not load preferences")
		return
	}
	httpx.WriteJSON(w, p)
}

func (a *app) handleSavePrefs(w http.ResponseWriter, r *http.Request) {
	var p prefs
	if !httpx.DecodeJSON(w, r, &p, 16<<10) {
		return
	}
	expectedRevision, err := ifMatchRevision(r)
	if err != nil {
		httpx.WriteJSONStatus(w, http.StatusBadRequest, map[string]any{
			"error": "invalid preference revision",
			"code":  "invalid_preferences_revision",
		})
		return
	}
	if err := validatePrefs(&p); err != nil {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_preferences", err.Error())
		return
	}
	if err := savePrefs(a.db, &p, expectedRevision); errors.Is(err, errRevisionConflict) {
		current, currentErr := getPrefs(a.db)
		if currentErr != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "load_preferences_failed", "could not load preferences")
			return
		}
		httpx.WriteJSONStatus(w, http.StatusConflict, map[string]any{
			"error":            "preferences changed on another device",
			"code":             "preferences_revision_conflict",
			"current_revision": current.Revision,
		})
		return
	} else if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "save_preferences_failed", "could not save preferences")
		return
	}
	saved, err := getPrefs(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "load_preferences_failed", "could not load preferences")
		return
	}
	a.publishChange("preferences")
	httpx.WriteJSON(w, saved)
}

func ifMatchRevision(r *http.Request) (*int64, error) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" || raw == "*" {
		return nil, nil
	}
	raw = strings.Trim(raw, `"`)
	revision, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || revision < 1 {
		return nil, errors.New("invalid preference revision")
	}
	return &revision, nil
}
