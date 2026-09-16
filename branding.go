package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	appNameEnv         = "VYLK_APP_NAME"
	defaultAppName     = "VYLK"
	appNamePlaceholder = "__VYLK_APP_NAME__"
	maxAppNameRunes    = 64
)

func configuredAppName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return defaultAppName, nil
	}
	if !utf8.ValidString(name) {
		return "", fmt.Errorf("%s must contain valid UTF-8", appNameEnv)
	}
	if utf8.RuneCountInString(name) > maxAppNameRunes {
		return "", fmt.Errorf("%s must be at most %d characters", appNameEnv, maxAppNameRunes)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("%s must not contain control characters", appNameEnv)
		}
	}
	return name, nil
}

func renderAppShell(name string) ([]byte, error) {
	shell, err := staticFS.ReadFile("static/index.html")
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(shell, []byte(appNamePlaceholder)) {
		return nil, fmt.Errorf("static app shell is missing the app name placeholder")
	}
	return bytes.ReplaceAll(shell, []byte(appNamePlaceholder), []byte(html.EscapeString(name))), nil
}

func serveAppShell(w http.ResponseWriter, r *http.Request, shell []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	http.ServeContent(w, r, "index.html", zeroTime, bytes.NewReader(shell))
}

func handleManifest(w http.ResponseWriter, _ *http.Request) {
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
		Name:            appName,
		ShortName:       appName,
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

type manifestIcon struct {
	Source string `json:"src"`
	Sizes  string `json:"sizes"`
	Type   string `json:"type"`
}
