package server

import (
	"net/http"
	"strings"
	"time"

	notepkg "vylk/internal/note"
	"vylk/internal/web"
)

func newHandler(a *app, assets *web.Assets, artificialDelay time.Duration) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("GET /manifest.json", assets.Manifest)
	mux.HandleFunc("POST /api/logout", a.auth(a.handleLogout))
	mux.HandleFunc("GET /api/check", a.auth(a.handleCheck))
	mux.HandleFunc("GET /api/notes", a.auth(a.handleListNotes))
	mux.HandleFunc("GET /api/search", a.auth(a.handleSearchNotes))
	mux.HandleFunc("GET /api/sync", a.auth(a.handleSyncChanges))
	mux.HandleFunc("GET /api/sync/notes", a.auth(a.handleBulkGetNotes))
	mux.HandleFunc("POST /api/sync/push", a.auth(a.handleSyncPush))
	mux.HandleFunc("GET /api/events", a.auth(a.handleEvents))
	mux.HandleFunc("GET /api/notes/{id}", a.auth(a.handleGetNote))
	mux.HandleFunc("POST /api/notes", a.auth(a.handleSaveNote))
	mux.HandleFunc("DELETE /api/notes/{id}", a.auth(a.handleDeleteNote))
	mux.HandleFunc("GET /api/tags", a.auth(a.handleListTags))
	mux.HandleFunc("GET /api/prefs", a.auth(a.handleGetPrefs))
	mux.HandleFunc("PATCH /api/prefs", a.auth(a.handleSavePrefs))
	mux.Handle("GET /", assets.Handler(func(path string) bool {
		return notepkg.ValidID(strings.TrimPrefix(path, "/"))
	}))
	return securityHeaders(gzipMiddleware(artificialRTTDelayMiddleware(artificialDelay, mux)))
}
