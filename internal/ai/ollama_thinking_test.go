package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestOllamaThinkingRequiresAdvertisedOffAndOn(t *testing.T) {
	for _, tc := range []struct {
		metadata, effort string
	}{
		{`{"thinking":{"values":[false,true],"default":true}}`, "medium"},
		{`{"thinking":{"values":["none","low","high"],"default":"high"}}`, "high"},
		{`{"thinking":{"values":["none","low","high"]}}`, "low"},
		{`{"thinking":{"values":[false,"low","high"],"default":"high"}}`, "high"},
		{`{"thinking":{"values":["low","medium","high"]}}`, ""},
		{`{"thinking":{"values":[true]}}`, ""},
		{`{"thinking":{"values":[false]}}`, ""},
		{`{"capabilities":["thinking"]}`, ""},
		{`{"capabilities":["tools","thinking","completion","vision"],"details":{"family":"qwen35","quantization_level":"Q4_K_M"}}`, "medium"},
		{`{"thinking":null,"capabilities":["thinking"],"details":{"family":"qwen35"}}`, "medium"},
		{`{"capabilities":["completion"],"details":{"family":"qwen35"}}`, ""},
		{`{"capabilities":["thinking"],"details":{"family":"gptoss"}}`, ""},
		{`{"capabilities":["thinking"],"details":{"family":"unknown"}}`, ""},
		{`{"thinking":{"values":[true]},"capabilities":["thinking"],"details":{"family":"qwen35"}}`, ""},
		{`{"thinking":{"values":[null,false]}}`, ""},
		{`{"thinking":{"values":[0,false]}}`, ""},
		{`{"thinking":{"values":[false,true]}} {}`, ""},
		{`{"thinking":{"values":[false,true]}`, ""},
	} {
		t.Run(tc.metadata, func(t *testing.T) {
			got := advertisedOllamaThinking(strings.NewReader(tc.metadata))
			if got.Controllable != (tc.effort != "") || got.ollamaEffort != tc.effort {
				t.Fatal(got)
			}
		})
	}
}

func TestOllamaDiscoveryAndExplicitPerRequestThinking(t *testing.T) {
	p := NewProvider()
	defer p.Close()
	metadataCalls, completions := 0, 0
	p.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatal("missing configured authentication")
		}
		switch r.URL.String() {
		case "http://localhost:11434/proxy/api/show":
			metadataCalls++
			var body map[string]string
			if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 1 || body["model"] != "qwen-local" {
				t.Fatal("metadata request includes more than the model name")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"thinking":{"values":[false,true],"default":true}}`))}, nil
		case "http://localhost:11434/proxy/v1/chat/completions":
			var body struct {
				Reasoning json.RawMessage `json:"reasoning"`
				Effort    string          `json:"reasoning_effort"`
				MaxTokens *int            `json:"max_tokens"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.Reasoning != nil || body.MaxTokens != nil {
				t.Fatal("unexpected completion parameters")
			}
			want := []string{"none", "medium", "none", ""}[completions]
			if body.Effort != want {
				t.Fatalf("effort %q; want %q", body.Effort, want)
			}
			completions++
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}]}`))}, nil
		default:
			t.Fatalf("unexpected URL %s", r.URL)
			return nil, nil
		}
	})
	c := Configuration{URL: "http://localhost:11434/proxy/v1/", Model: "qwen-local", Key: "secret"}
	c = p.WithCapabilities(context.Background(), c, false)
	if !c.ThinkingControllable || c.ThinkingEffort != "medium" {
		t.Fatal(c.ThinkingControllable, c.ThinkingEffort)
	}
	_ = p.WithCapabilities(context.Background(), c, false)
	if metadataCalls != 1 {
		t.Fatal("metadata not cached")
	}
	for _, enabled := range []bool{false, true, false} {
		c.Thinking = &enabled
		if _, _, _, err := p.Complete(context.Background(), c, []Message{{Role: "user", Content: "test"}}, 0); err != nil {
			t.Fatal(err)
		}
	}
	c.ThinkingControllable = false
	if _, _, _, err := p.Complete(context.Background(), c, []Message{{Role: "user", Content: "test"}}, 0); err != nil {
		t.Fatal(err)
	}
	if completions != 4 {
		t.Fatal(completions)
	}
	_ = p.WithCapabilities(context.Background(), c, true)
	if metadataCalls != 2 {
		t.Fatal("explicit Test did not refresh metadata")
	}
}

func TestOllamaDiscoveryDoesNotGuessNonV1Routes(t *testing.T) {
	for _, endpoint := range []string{"https://example.com/api/v2", "https://example.com/v1beta/openai"} {
		req, err := ollamaThinkingRequest(context.Background(), Configuration{URL: endpoint, Model: "model"})
		if err != nil || req != nil {
			t.Fatal(req, err)
		}
	}
}
