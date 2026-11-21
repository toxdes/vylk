package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContextPreflightCachesMetadataAndNeverSendsNoteText(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Path != "/models" || r.Header.Get("Authorization") != "Bearer private" || r.ContentLength > 0 {
			t.Error("invalid metadata request")
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"small","context_length":4096}]}`))
	}))
	defer server.Close()
	p := NewProvider()
	defer p.Close()
	c := Configuration{URL: server.URL, Key: "private", Model: "small"}
	for range 2 {
		if err := p.Preflight(context.Background(), c, []Message{{Role: "user", Content: strings.Repeat("private note text ", 2000)}}); err == nil || !strings.Contains(err.Error(), "no AI request was sent") {
			t.Fatal("oversized context not rejected", err)
		}
	}
	if calls != 1 {
		t.Fatal("metadata was not cached", calls)
	}
	if err := p.Preflight(context.Background(), c, []Message{{Role: "user", Content: "small note"}}); err != nil {
		t.Fatal(err)
	}
}

func TestContextMetadataIsOptionalAndCredentialScoped(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(404)
	}))
	defer server.Close()
	p := NewProvider()
	defer p.Close()
	c := Configuration{URL: server.URL, Key: "one", Model: "custom"}
	for range 2 {
		if err := p.Preflight(context.Background(), c, []Message{{Role: "user", Content: "hello"}}); err != nil {
			t.Fatal(err)
		}
	}
	c.Key = "two"
	if err := p.Preflight(context.Background(), c, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("unknown results not cached, or credentials shared metadata", calls)
	}
}

func TestAdvertisedContextOnlyUsesTheSelectedModel(t *testing.T) {
	for _, tc := range []struct {
		data string
		want int
	}{
		{`{"data":{"id":"author/model","context_length":1000000}}`, 1000000},
		{`{"data":[{"id":"other","context_length":1000000},{"id":"author/model","max_model_len":8192}]}`, 8192},
		{`{"data":[{"id":"other","context_length":1000000}]}`, 0},
		{`{"data":{"id":"author/model","context_length":-1}}`, 0},
		{`{"data":{"id":"author/model","context_length":2147483647}}`, 0},
	} {
		if got := advertisedContext([]byte(tc.data), "author/model"); got != tc.want {
			t.Fatal(got, tc.want)
		}
	}
}
