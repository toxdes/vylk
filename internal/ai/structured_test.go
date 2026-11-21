package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestStructuredCapabilitiesRequireBothAdvertisements(t *testing.T) {
	for _, tc := range []struct {
		params string
		want   bool
	}{
		{`["structured_outputs","response_format"]`, true},
		{`["structured_outputs"]`, false},
		{`["response_format"]`, false},
		{`[]`, false},
	} {
		catalog := `{"data":[{"id":"model","supported_parameters":` + tc.params + `}]}`
		if got := advertisedCapabilities(strings.NewReader(catalog), "model").Structured; got != tc.want {
			t.Fatal(tc.params, got)
		}
	}
}

func TestDetectedOllamaUsesSchemaWithoutOpenRouterRouting(t *testing.T) {
	p := NewProvider()
	defer p.Close()
	p.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
		var body struct {
			Format  map[string]any   `json:"response_format"`
			Routing *providerRouting `json:"provider"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Routing != nil || body.Format["type"] != "json_schema" {
			t.Fatal(body)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}]}`))}, nil
	})
	_, _, _, err := p.Complete(context.Background(), Configuration{URL: "http://localhost:11434/v1", Ollama: true, StructuredOutput: true}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
}

func TestProviderSendsSchemaOnlyWhenKnownAndNeverRetries(t *testing.T) {
	for _, tc := range []struct {
		name, url string
		known     bool
		status    int
	}{
		{"supported", "https://openrouter.ai/api/v1", true, 200},
		{"unknown", "https://openrouter.ai/api/v1", false, 200},
		{"generic", "https://example.com/v1", true, 200},
		{"rejected schema", "https://openrouter.ai/api/v1", true, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			p := NewProvider()
			defer p.Close()
			p.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				var body struct {
					Format    map[string]any   `json:"response_format"`
					Provider  *providerRouting `json:"provider"`
					MaxTokens *int             `json:"max_tokens"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				want := tc.known && openRouterEndpoint(tc.url)
				if want {
					if body.Format["type"] != "json_schema" || body.Provider == nil || !body.Provider.RequireParameters {
						t.Fatal("schema can be silently ignored")
					}
					schema := body.Format["json_schema"].(map[string]any)
					if schema["strict"] != true || schema["schema"].(map[string]any)["additionalProperties"] != false {
						t.Fatal("schema is not strict")
					}
				} else if body.Format != nil || body.Provider != nil {
					t.Fatal("sent unadvertised parameters")
				}
				if body.MaxTokens != nil {
					t.Fatal("normal generation capped")
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}]}`))}, nil
			})
			_, _, _, err := p.Complete(context.Background(), Configuration{URL: tc.url, Model: "model", StructuredOutput: tc.known}, nil, 0)
			if (err != nil) != (tc.status != 200) || calls != 1 {
				t.Fatal("unexpected result or automatic retry", err, calls)
			}
		})
	}
}
