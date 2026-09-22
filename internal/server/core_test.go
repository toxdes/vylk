package server

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vylk/internal/auth"
	"vylk/internal/web"
)

type sseTestRecorder struct {
	*httptest.ResponseRecorder
	flushes int
}

func TestStaticCachePreventsProxyTransforms(t *testing.T) {
	handler := web.CacheMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), func(string) bool { return false })

	for _, path := range []string{"/", "/style.css", "/js/editor/interactive-preview.js", "/js/editor/zen-editor.js", "/js/workers/preview-worker.js"} {
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, path, nil))
		if cacheControl := result.Header().Get("Cache-Control"); !strings.Contains(cacheControl, "no-transform") {
			t.Fatalf("Cache-Control for %s = %q, want no-transform", path, cacheControl)
		}
	}
}

func TestConfiguredAppName(t *testing.T) {
	tests := []struct {
		raw     string
		want    string
		wantErr bool
	}{
		{raw: "", want: web.DefaultName},
		{raw: "  Acme Notes  ", want: "Acme Notes"},
		{raw: strings.Repeat("x", web.MaxNameRunes+1), wantErr: true},
		{raw: "Acme\nNotes", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			got, err := web.ConfiguredName(test.raw)
			if test.wantErr {
				if err == nil {
					t.Fatalf("configuredAppName(%q) returned %q without an error", test.raw, got)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("configuredAppName(%q) = %q, %v; want %q", test.raw, got, err, test.want)
			}
		})
	}
}

func TestRenderedAppShellEscapesConfiguredName(t *testing.T) {
	shell, err := web.RenderAppShell(`Acme & <Notes> "today"`)
	if err != nil {
		t.Fatalf("render app shell: %v", err)
	}
	if !strings.Contains(string(shell), "Acme &amp; &lt;Notes&gt; &#34;today&#34;") {
		t.Fatalf("rendered shell does not contain escaped app name")
	}
	if strings.Contains(string(shell), web.AppNamePlaceholder) {
		t.Fatalf("rendered shell still contains app name placeholder")
	}
	result := httptest.NewRecorder()
	web.ServeAppShell(result, httptest.NewRequest(http.MethodGet, "/", nil), shell)
	if result.Header().Get("Cache-Control") != "no-cache, no-transform" {
		t.Fatalf("app shell cache control = %q", result.Header().Get("Cache-Control"))
	}
}

func TestManifestUsesConfiguredAppName(t *testing.T) {
	assets, err := web.New("Acme Notes")
	if err != nil {
		t.Fatalf("new web assets: %v", err)
	}
	result := httptest.NewRecorder()
	assets.Manifest(result, httptest.NewRequest(http.MethodGet, "/manifest.json", nil))
	if result.Code != http.StatusOK || result.Header().Get("Content-Type") != "application/manifest+json; charset=utf-8" {
		t.Fatalf("manifest response = status %d, content type %q", result.Code, result.Header().Get("Content-Type"))
	}
	if result.Header().Get("Cache-Control") != "no-cache, no-transform" {
		t.Fatalf("manifest cache control = %q", result.Header().Get("Cache-Control"))
	}
	var manifest map[string]any
	if err := json.Unmarshal(result.Body.Bytes(), &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if manifest["name"] != "Acme Notes" || manifest["short_name"] != "Acme Notes" {
		t.Fatalf("manifest names = %#v", manifest)
	}
}

func TestAppRevisionIncludesConfiguredAppName(t *testing.T) {
	if web.Revision("VYLK") == web.Revision("Acme Notes") {
		t.Fatal("app revision did not change with configured app name")
	}
}

func TestSecurityHeadersUseStrictCSP(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, "/", nil))

	csp := result.Header().Get("Content-Security-Policy")
	for _, directive := range []string{"script-src 'self'", "style-src 'self'", "connect-src 'self'", "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com", "worker-src 'self'", "object-src 'none'"} {
		if !strings.Contains(csp, directive) {
			t.Fatalf("CSP %q is missing %q", csp, directive)
		}
	}
}

func TestParseArtificialRTTDelay(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{name: "absent", raw: "", want: 0},
		{name: "zero", raw: "0", want: 0},
		{name: "milliseconds", raw: "25", want: 25 * time.Millisecond},
		{name: "whitespace", raw: " 40 ", want: 40 * time.Millisecond},
		{name: "invalid", raw: "slow", want: 0},
		{name: "negative", raw: "-1", want: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := parseArtificialRTTDelay(test.raw)
			if got != test.want {
				t.Fatalf("parseArtificialRTTDelay(%q) = %s, want %s", test.raw, got, test.want)
			}
		})
	}
}

func TestArtificialRTTDelayMiddlewareDelaysRequestsButNotSSE(t *testing.T) {
	const delay = 15 * time.Millisecond
	handler := artificialRTTDelayMiddleware(delay, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	start := time.Now()
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, "/api/check", nil))
	if elapsed := time.Since(start); elapsed < delay {
		t.Fatalf("API request completed in %s, want at least %s", elapsed, delay)
	}

	start = time.Now()
	result = httptest.NewRecorder()
	handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, "/api/events", nil))
	if elapsed := time.Since(start); elapsed >= delay {
		t.Fatalf("SSE request completed in %s, want less than %s", elapsed, delay)
	}
}

func TestAPIValidationErrorsUseStableJSONCodes(t *testing.T) {
	a := &app{}
	request := httptest.NewRequest(http.MethodGet, "/api/search?q="+strings.Repeat("x", 257), nil)
	result := httptest.NewRecorder()
	a.handleSearchNotes(result, request)

	if result.Code != http.StatusBadRequest || !strings.Contains(result.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("validation response = status %d, content type %q", result.Code, result.Header().Get("Content-Type"))
	}
	var body map[string]any
	if err := json.Unmarshal(result.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode validation response: %v", err)
	}
	if body["code"] != "search_query_too_long" || body["error"] != "search query is too long" {
		t.Fatalf("validation body = %#v", body)
	}
}

func TestGzipMiddlewareCompressesErrorResponsesCorrectly(t *testing.T) {
	handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	request := httptest.NewRequest(http.MethodGet, "/style.css", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)

	if result.Code != http.StatusForbidden || result.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip error response = status %d, encoding %q", result.Code, result.Header().Get("Content-Encoding"))
	}
	reader, err := gzip.NewReader(result.Body)
	if err != nil {
		t.Fatalf("read gzip response: %v", err)
	}
	decompressed, err := io.ReadAll(reader)
	if closeErr := reader.Close(); err == nil {
		err = closeErr
	}
	if err != nil || string(decompressed) != "forbidden\n" {
		t.Fatalf("gzip error body = %q, %v", decompressed, err)
	}
}

func TestGzipMiddlewareLeavesServiceWorkerShellUncompressed(t *testing.T) {
	handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("shell"))
	}))
	request := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	request.Header.Set("X-Vylk-Shell", "1")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)

	if result.Code != http.StatusOK || result.Header().Get("Content-Encoding") != "" || result.Body.String() != "shell" {
		t.Fatalf("service worker shell response = status %d, encoding %q, body %q", result.Code, result.Header().Get("Content-Encoding"), result.Body.String())
	}
}

func TestLegacyIPBansAreClearedByMigration(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("create migration table: %v", err)
	}
	for _, migration := range migrations[:10] {
		tx, err := db.Begin()
		if err != nil {
			t.Fatalf("begin migration %d: %v", migration.Version, err)
		}
		if err := migration.Up(tx); err != nil {
			tx.Rollback()
			t.Fatalf("apply migration %d: %v", migration.Version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.Version, "2025-01-01T00:00:00Z"); err != nil {
			tx.Rollback()
			t.Fatalf("record migration %d: %v", migration.Version, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit migration %d: %v", migration.Version, err)
		}
	}
	if _, err := db.Exec("INSERT INTO ip_bans (ip, reason, created_at) VALUES ('203.0.113.7', 'too many 404s', '2025-01-01T00:00:00Z')"); err != nil {
		t.Fatalf("insert legacy ban: %v", err)
	}
	if err := initDB(db); err != nil {
		t.Fatalf("apply ban-clearing migration: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM ip_bans").Scan(&count); err != nil || count != 0 {
		t.Fatalf("legacy bans after migration = %d, %v; want 0", count, err)
	}
}

func TestRateLimiterBanIsTemporaryAndLoginWindowResets(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	rl, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	for range 5 {
		if err := rl.RecordLoginAttempt("203.0.113.7", false); err != nil {
			t.Fatalf("record failed login: %v", err)
		}
	}
	if banned, err := rl.IsBanned("203.0.113.7"); err != nil || !banned {
		t.Fatalf("temporary login ban = %t, %v; want true", banned, err)
	}
	restarted, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatalf("restart rate limiter: %v", err)
	}
	if banned, err := restarted.IsBanned("203.0.113.7"); err != nil || banned {
		t.Fatalf("ban persisted after restart = %t, %v; want false", banned, err)
	}
	old := time.Now().UTC().Add(-auth.LoginAttemptWindow - time.Minute).Format(time.RFC3339)
	if _, err := db.Exec("INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'login', 4, ?)", "203.0.113.8", old); err != nil {
		t.Fatalf("seed expired login attempts: %v", err)
	}
	if err := rl.RecordLoginAttempt("203.0.113.8", false); err != nil {
		t.Fatalf("record login after expired window: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'login'", "203.0.113.8").Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired-window login count = %d, %v; want 1", count, err)
	}
}

func TestLoginRateLimitExpiresAfterAdvertisedBackoff(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	rl, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	updated := time.Now().UTC().Add(-2 * time.Second).Format(time.RFC3339)
	if _, err := db.Exec("INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'login', 5, ?)", "203.0.113.10", updated); err != nil {
		t.Fatalf("seed login limit: %v", err)
	}

	retryAfter, err := rl.LoginRetryAfter("203.0.113.10")
	if err != nil {
		t.Fatalf("check login retry: %v", err)
	}
	if retryAfter != 0 {
		t.Fatalf("retry after elapsed one-second backoff = %d; want 0", retryAfter)
	}
}

func TestLoginRateLimitDoesNotBlockAuthenticatedRoutes(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	rl, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	for range 5 {
		if err := rl.RecordLoginAttempt("203.0.113.9", false); err != nil {
			t.Fatalf("record failed login: %v", err)
		}
	}
	a := &app{db: db, password: "correct", sessions: auth.NewSessionStore(db), rl: rl}
	login := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"password":"wrong"}`))
	login.RemoteAddr = "203.0.113.9:1234"
	login.Header.Set("Content-Type", "application/json")
	loginResult := httptest.NewRecorder()
	a.handleLogin(loginResult, login)
	if loginResult.Code != http.StatusTooManyRequests || loginResult.Header().Get("Retry-After") == "" {
		t.Fatalf("rate-limited login = %d, retry-after %q", loginResult.Code, loginResult.Header().Get("Retry-After"))
	}
	var attempts int
	if err := db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'login'", "203.0.113.9").Scan(&attempts); err != nil || attempts != 5 {
		t.Fatalf("attempts after rate-limited request = %d, %v; want 5", attempts, err)
	}

	token, err := a.sessions.Create()
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	check := httptest.NewRequest(http.MethodGet, "/api/check", nil)
	check.RemoteAddr = "203.0.113.9:1234"
	check.AddCookie(&http.Cookie{Name: "session", Value: token})
	checkResult := httptest.NewRecorder()
	a.auth(a.handleCheck)(checkResult, check)
	if checkResult.Code != http.StatusOK {
		t.Fatalf("authenticated route after login limit = %d: %s", checkResult.Code, checkResult.Body.String())
	}
}

func TestSuccessfulLoginReturnsAuthoritativeAppRevision(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	rl, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	a := &app{db: db, password: "correct", sessions: auth.NewSessionStore(db), rl: rl}
	request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"password":"correct"}`))
	request.RemoteAddr = "203.0.113.11:1234"
	response := httptest.NewRecorder()

	a.handleLogin(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("login status = %d: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if body["ok"] != true || body["version"] != version || body["revision"] != appRevision {
		t.Fatalf("login app identity = %#v; want version %q revision %q", body, version, appRevision)
	}
}

func (r *sseTestRecorder) Flush() {
	r.flushes++
}

func (r *sseTestRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseRecorder
}
