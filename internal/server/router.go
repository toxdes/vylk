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
	mux.HandleFunc("GET /api/vault/bootstrap", a.handleVaultBootstrap)
	mux.HandleFunc("POST /api/vault/reset", a.vaultChange(a.handleVaultReset))
	mux.HandleFunc("GET /api/vault/keys", a.auth(a.handleVaultKeys))
	mux.HandleFunc("POST /api/vault/credentials", a.auth(a.vaultChange(a.handleVaultCredentialChange)))
	mux.HandleFunc("POST /api/vault/migration/start", a.auth(a.vaultChange(a.handleVaultMigrationStart)))
	mux.HandleFunc("GET /api/vault/migration/status", a.auth(a.handleVaultMigrationStatus))
	mux.HandleFunc("GET /api/vault/migration/next", a.auth(a.handleVaultMigrationNext))
	mux.HandleFunc("POST /api/vault/migration/stage", a.auth(a.vaultChange(a.handleVaultMigrationStage)))
	mux.HandleFunc("GET /api/vault/migration/staged/{id}", a.auth(a.handleVaultMigrationStagedNote))
	mux.HandleFunc("POST /api/vault/migration/verify", a.auth(a.vaultChange(a.handleVaultMigrationVerify)))
	mux.HandleFunc("POST /api/vault/migration/commit", a.auth(a.vaultChange(a.handleVaultMigrationCommit)))
	mux.HandleFunc("GET /manifest.json", assets.Manifest)
	mux.HandleFunc("POST /api/logout", a.auth(a.handleLogout))
	mux.HandleFunc("GET /api/check", a.auth(a.handleCheck))
	mux.HandleFunc("GET /api/devices", a.auth(a.handleDevices))
	mux.HandleFunc("DELETE /api/devices/{id}", a.auth(a.vaultChange(a.handleSignOutDevice)))
	mux.HandleFunc("GET /api/notes", a.vaultRoute(a.handleListNotes, a.handleVaultListNotes, false))
	mux.HandleFunc("GET /api/search", a.vaultRoute(a.handleSearchNotes, a.handleVaultClientSearch, false))
	mux.HandleFunc("GET /api/sync", a.vaultRoute(a.handleSyncChanges, a.handleSyncChanges, false))
	mux.HandleFunc("GET /api/sync/notes", a.vaultRoute(a.handleBulkGetNotes, a.handleVaultBulkGetNotes, false))
	mux.HandleFunc("POST /api/sync/push", a.vaultRoute(a.handleSyncPush, a.handleVaultSyncPush, true))
	mux.HandleFunc("GET /api/events", a.auth(a.handleEvents))
	mux.HandleFunc("GET /api/notes/{id}", a.vaultRoute(a.handleGetNote, a.handleVaultGetNote, false))
	mux.HandleFunc("POST /api/notes", a.vaultRoute(a.handleSaveNote, a.handleVaultSaveNote, true))
	mux.HandleFunc("DELETE /api/notes/{id}", a.vaultRoute(a.handleDeleteNote, a.handleVaultDeleteNote, true))
	mux.HandleFunc("GET /api/tags", a.vaultRoute(a.handleListTags, a.handleVaultClientSearch, false))
	mux.HandleFunc("GET /api/prefs", a.auth(a.handleGetPrefs))
	mux.HandleFunc("PATCH /api/prefs", a.auth(a.handleSavePrefs))
	mux.Handle("GET /", assets.Handler(func(path string) bool {
		return isPreferencesPath(path) || notepkg.ValidID(strings.TrimPrefix(path, "/"))
	}))
	return securityHeaders(gzipMiddleware(artificialRTTDelayMiddleware(artificialDelay, mux)))
}

func isPreferencesPath(path string) bool {
	if path == "/preferences" {
		return true
	}
	if !strings.HasPrefix(path, "/preferences/") {
		return false
	}

	sectionPath := strings.TrimPrefix(path, "/preferences/")
	switch sectionPath {
	case "appearance", "editor", "zen", "shortcuts", "account", "encryption", "about":
		return true
	case "encryption/setup", "encryption/passphrase", "encryption/recovery":
		return true
	default:
		return false
	}
}
