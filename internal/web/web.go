// Package web owns Vylk's embedded browser application and its HTTP delivery
// policy.
package web

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	NameEnv            = "VYLK_APP_NAME"
	DefaultName        = "VYLK"
	AppNamePlaceholder = "__VYLK_APP_NAME__"
	MaxNameRunes       = 64
)

//go:embed static
var embedded embed.FS

var zeroTime time.Time

// revisionFiles is the production frontend surface. Test and development-only
// files stay out of the fingerprint so they cannot trigger client updates.
var revisionFiles = []string{
	"static/index.html",
	"static/style.css",
	"static/js/app.js",
	"static/js/core/http.js",
	"static/js/core/routes.js",
	"static/js/core/indexeddb.js",
	"static/js/core/offline-store.js",
	"static/js/editor/shortcuts.js",
	"static/js/editor/interactive-preview.js",
	"static/js/editor/markdown-formatting.js",
	"static/js/editor/zen-editor.js",
	"static/js/workers/preview-worker.js",
	"static/js/ui/themes.js",
	"static/js/editor/merge.js",
	"static/vendor/marked.min.js",
	"static/manifest.json",
	"static/favicon.ico",
	"static/icon-192.png",
	"static/icon-512.png",
	"static/sw.js",
}

// Assets is an immutable, configured view of the embedded web application.
type Assets struct {
	name     string
	revision string
	shell    []byte
	files    fs.FS
}

func New(name string) (*Assets, error) {
	shell, err := RenderAppShell(name)
	if err != nil {
		return nil, err
	}
	files, err := fs.Sub(embedded, "static")
	if err != nil {
		return nil, err
	}
	return &Assets{name: name, revision: Revision(name), shell: shell, files: files}, nil
}

func (a *Assets) Revision() string { return a.revision }

func ConfiguredName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return DefaultName, nil
	}
	if !utf8.ValidString(name) {
		return "", fmt.Errorf("%s must contain valid UTF-8", NameEnv)
	}
	if utf8.RuneCountInString(name) > MaxNameRunes {
		return "", fmt.Errorf("%s must be at most %d characters", NameEnv, MaxNameRunes)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("%s must not contain control characters", NameEnv)
		}
	}
	return name, nil
}

func Revision(name string) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte("app-name\x00" + name + "\x00"))
	for _, path := range revisionFiles {
		data, err := embedded.ReadFile(path)
		if err != nil {
			return "unknown"
		}
		_, _ = hash.Write([]byte(path))
		_, _ = hash.Write(data)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)[:8])
}

func RenderAppShell(name string) ([]byte, error) {
	shell, err := embedded.ReadFile("static/index.html")
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(shell, []byte(AppNamePlaceholder)) {
		return nil, fmt.Errorf("static app shell is missing the app name placeholder")
	}
	return bytes.ReplaceAll(shell, []byte(AppNamePlaceholder), []byte(html.EscapeString(name))), nil
}

func ServeAppShell(w http.ResponseWriter, r *http.Request, shell []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	http.ServeContent(w, r, "index.html", zeroTime, bytes.NewReader(shell))
}

func (a *Assets) Manifest(w http.ResponseWriter, _ *http.Request) {
	manifest := struct {
		Name            string         `json:"name"`
		ShortName       string         `json:"short_name"`
		Description     string         `json:"description"`
		StartURL        string         `json:"start_url"`
		Display         string         `json:"display"`
		BackgroundColor string         `json:"background_color"`
		ThemeColor      string         `json:"theme_color"`
		Icons           []manifestIcon `json:"icons"`
	}{
		Name:            a.name,
		ShortName:       a.name,
		Description:     "A lightweight, self-hosted Markdown notes app with offline support.",
		StartURL:        "/",
		Display:         "standalone",
		BackgroundColor: "#fafafa",
		ThemeColor:      "#ae2448",
		Icons: []manifestIcon{
			{Source: "/icon-192.png", Sizes: "192x192", Type: "image/png"},
			{Source: "/icon-512.png", Sizes: "512x512", Type: "image/png"},
		},
	}
	w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	_ = json.NewEncoder(w).Encode(manifest)
}

// Handler serves immutable assets and the SPA shell. isAppPath identifies
// application routes that should receive the shell instead of a static 404.
func (a *Assets) Handler(isAppPath func(string) bool) http.Handler {
	fileServer := CacheMiddleware(http.FileServer(http.FS(a.files)), isAppPath)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" || isAppPath(r.URL.Path) {
			ServeAppShell(w, r, a.shell)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func CacheMiddleware(next http.Handler, isAppPath func(string) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/index.html", "/sw.js", "/manifest.json", "/js/app.js", "/js/core/http.js", "/js/core/routes.js", "/js/core/indexeddb.js", "/js/core/offline-store.js", "/js/editor/shortcuts.js", "/js/editor/interactive-preview.js", "/js/editor/markdown-formatting.js", "/js/editor/zen-editor.js", "/js/workers/preview-worker.js", "/style.css", "/js/ui/themes.js", "/js/editor/merge.js", "/vendor/marked.min.js":
			w.Header().Set("Cache-Control", "no-cache, no-transform")
		default:
			if isAppPath(r.URL.Path) {
				w.Header().Set("Cache-Control", "no-cache, no-transform")
				break
			}
			w.Header().Set("Cache-Control", "public, max-age=86400, no-transform")
		}
		next.ServeHTTP(w, r)
	})
}

type manifestIcon struct {
	Source string `json:"src"`
	Sizes  string `json:"sizes"`
	Type   string `json:"type"`
}
