package web

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestRenderAppShellUsesSiteDocumentationURL(t *testing.T) {
	shell, err := RenderAppShell(DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(shell, []byte(DocsURLPlaceholder)) {
		t.Fatal("documentation URL placeholder was not replaced")
	}
	if count := bytes.Count(shell, []byte(`href="`+DocsURL+`"`)); count != 2 {
		t.Fatalf("documentation link count = %d, want 2", count)
	}
}

func TestShellCarriesItsActualRevision(t *testing.T) {
	shell, err := RenderAppShell(DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(shell, []byte(`name="vylk-revision" content="`+Revision(DefaultName)+`"`)) {
		t.Fatal("shell revision missing")
	}
}

func TestRuntimeModulesChangeRevisionButTestsDoNot(t *testing.T) {
	files := fstest.MapFS{}
	for _, path := range revisionFiles {
		files[path] = &fstest.MapFile{Data: []byte("asset")}
	}
	files["static/js/ui/devices.js"] = &fstest.MapFile{Data: []byte("runtime")}
	first := revisionOf(files, DefaultName)
	if first == "unknown" {
		t.Fatal("could not fingerprint fixture")
	}
	files["static/js/ui/devices.test.js"] = &fstest.MapFile{Data: []byte("test")}
	if revisionOf(files, DefaultName) != first {
		t.Fatal("test changed runtime revision")
	}
	files["static/js/ui/devices.js"] = &fstest.MapFile{Data: []byte("changed runtime")}
	if revisionOf(files, DefaultName) == first {
		t.Fatal("runtime module absent from revision")
	}
}

func TestEveryRuntimeScriptRevalidates(t *testing.T) {
	handler := CacheMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }), func(string) bool { return false })
	for _, path := range []string{"/sw.js", "/js/ui/devices.js", "/js/ui/feedback.js", "/js/core/vault-session.js"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Header().Get("Cache-Control") != "no-cache, no-transform" {
			t.Fatalf("cache policy %s: %s", path, w.Header().Get("Cache-Control"))
		}
	}
}
