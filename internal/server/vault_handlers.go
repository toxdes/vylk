package server

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"

	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/store"
)

type vaultNoteWire struct {
	ID        string          `json:"id"`
	Summary   json.RawMessage `json:"summary"`
	Body      json.RawMessage `json:"body,omitempty"`
	Pinned    bool            `json:"pinned"`
	PinOrder  int64           `json:"pin_order"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
	Revision  int64           `json:"revision"`
	Epoch     int64           `json:"epoch"`
}

func vaultWire(n store.VaultNote, body []byte) vaultNoteWire {
	return vaultNoteWire{ID: n.ID, Summary: json.RawMessage(n.Summary), Body: body,
		Pinned: n.Pinned, PinOrder: n.PinOrder, CreatedAt: n.CreatedAt,
		UpdatedAt: n.UpdatedAt, Revision: n.Revision, Epoch: n.Epoch}
}

func (a *app) readVaultNote(id string) (vaultNoteWire, error) {
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverVaultFileOperations(); err != nil {
		return vaultNoteWire{}, err
	}
	n, err := store.GetVaultNote(a.db, id)
	if err != nil {
		return vaultNoteWire{}, err
	}
	path, err := notepkg.SanitizePath(a.notesDir, n.Filename)
	if err != nil {
		return vaultNoteWire{}, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return vaultNoteWire{}, err
	}
	if !validVaultSummary(json.RawMessage(n.Summary)) || !validVaultEnvelope(body) {
		return vaultNoteWire{}, errors.New("encrypted note envelope is corrupt")
	}
	return vaultWire(n, body), nil
}

func (a *app) handleVaultListNotes(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("tag") != "" {
		httpx.WriteAPIError(w, http.StatusConflict, "client_search_required", "filter tags on this device")
		return
	}
	limit := 500
	paged := r.URL.Query().Has("limit")
	if paged {
		var err error
		limit, err = strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil || limit < 1 || limit > 500 {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_page_limit", "invalid page limit")
			return
		}
	}
	var cursorTime, cursorID string
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		var err error
		cursorTime, cursorID, err = store.DecodeNoteCursor(cursor)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_cursor", "invalid cursor")
			return
		}
	}
	all := make([]vaultNoteWire, 0)
	for {
		requested := limit
		if paged {
			requested++
		}
		page, err := store.ListVaultNotes(a.db, cursorTime, cursorID, requested)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "list_notes_failed", "could not list encrypted notes")
			return
		}
		if paged {
			hasMore := len(page) > limit
			if hasMore {
				page = page[:limit]
			}
			result := make([]vaultNoteWire, 0, len(page))
			for _, item := range page {
				result = append(result, vaultWire(item, nil))
			}
			cursor := ""
			if hasMore {
				last := page[len(page)-1]
				cursor = base64.RawURLEncoding.EncodeToString([]byte(last.UpdatedAt + "\x00" + last.ID))
			}
			httpx.WriteJSON(w, map[string]any{"notes": result, "nextCursor": cursor})
			return
		}
		for _, item := range page {
			all = append(all, vaultWire(item, nil))
		}
		if len(page) < requested {
			break
		}
		last := page[len(page)-1]
		cursorTime, cursorID = last.UpdatedAt, last.ID
	}
	httpx.WriteJSON(w, all)
}

func (a *app) handleVaultGetNote(w http.ResponseWriter, r *http.Request) {
	n, err := a.readVaultNote(r.PathValue("id"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.WriteAPIError(w, http.StatusNotFound, "note_not_found", "note not found")
			return
		}
		httpx.WriteAPIError(w, http.StatusInternalServerError, "load_note_failed", "could not load encrypted note")
		return
	}
	httpx.WriteJSON(w, n)
}

func (a *app) handleVaultBulkGetNotes(w http.ResponseWriter, r *http.Request) {
	rawIDs := strings.Split(r.URL.Query().Get("ids"), ",")
	if len(rawIDs) == 1 && rawIDs[0] == "" {
		httpx.WriteJSON(w, map[string]any{"notes": []vaultNoteWire{}, "missing": []string{}})
		return
	}
	if len(rawIDs) > 25 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "too_many_note_ids", "too many note ids")
		return
	}
	result := make([]vaultNoteWire, 0, len(rawIDs))
	missing := make([]string, 0)
	seen := make(map[string]bool, len(rawIDs))
	for _, id := range rawIDs {
		if !notepkg.ValidID(id) {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_note_id", "invalid note id")
			return
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		n, err := a.readVaultNote(id)
		if errors.Is(err, sql.ErrNoRows) {
			missing = append(missing, id)
			continue
		}
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "load_notes_failed", "could not load encrypted notes")
			return
		}
		result = append(result, n)
	}
	httpx.WriteJSON(w, map[string]any{"notes": result, "missing": missing})
}

type vaultSaveRequest struct {
	ID           string          `json:"id"`
	Summary      json.RawMessage `json:"summary"`
	Body         json.RawMessage `json:"body"`
	Epoch        int64           `json:"epoch"`
	BaseRevision *int64          `json:"base_revision"`
}

func (a *app) handleVaultSaveNote(w http.ResponseWriter, r *http.Request) {
	var request vaultSaveRequest
	if !httpx.DecodeJSON(w, r, &request, 8<<20) {
		return
	}
	if !notepkg.ValidID(request.ID) || request.BaseRevision == nil || *request.BaseRevision < 0 ||
		!validVaultSummary(request.Summary) || !validVaultEnvelope(request.Body) {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_encrypted_note", "invalid encrypted note")
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Epoch != request.Epoch {
		httpx.WriteAPIError(w, http.StatusConflict, "stale_vault_epoch", "refresh vault keys before saving")
		return
	}
	if err := a.recoverVaultFileOperations(); err != nil {
		httpx.WriteAPIError(w, http.StatusServiceUnavailable, "note_file_recovery_blocked", "encrypted file recovery is pending")
		return
	}
	n, err := a.saveVaultNote(request.ID, request.Summary, request.Body, request.Epoch, *request.BaseRevision)
	if errors.Is(err, store.ErrRevisionConflict) {
		httpx.WriteAPIError(w, http.StatusConflict, "note_revision_conflict", "note changed on another device")
		return
	}
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "save_note_failed", "could not save encrypted note")
		return
	}
	a.publishChange("notes")
	httpx.WriteJSON(w, vaultWire(n, nil))
}

func (a *app) handleVaultDeleteNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	base, err := strconv.ParseInt(r.URL.Query().Get("base_revision"), 10, 64)
	if !notepkg.ValidID(id) || err != nil || base < 1 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_note_revision", "invalid note or revision")
		return
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverVaultFileOperations(); err != nil {
		httpx.WriteAPIError(w, http.StatusServiceUnavailable, "note_file_recovery_blocked", "encrypted file recovery is pending")
		return
	}
	if err := a.deleteVaultNote(id, base); errors.Is(err, store.ErrRevisionConflict) {
		httpx.WriteAPIError(w, http.StatusConflict, "note_revision_conflict", "note changed on another device")
		return
	} else if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteAPIError(w, http.StatusNotFound, "note_not_found", "note not found")
		return
	} else if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "delete_note_failed", "could not delete encrypted note")
		return
	}
	a.publishChange("notes")
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleVaultClientSearch(w http.ResponseWriter, r *http.Request) {
	httpx.WriteAPIError(w, http.StatusConflict, "client_search_required", "search encrypted notes on this device")
}
