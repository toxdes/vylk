package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAdvertisedThinkingRequiresExplicitOptionalControl(t *testing.T) {
	for _, tc := range []struct {
		name, fields string
		want         bool
	}{
		{"optional", `"reasoning":{"mandatory":false},"supported_parameters":["reasoning"]`, true},
		{"mandatory", `"reasoning":{"mandatory":true},"supported_parameters":["reasoning"]`, false},
		{"unspecified", `"reasoning":{},"supported_parameters":["reasoning"]`, false},
		{"unsupported", `"reasoning":{"mandatory":false},"supported_parameters":[]`, false},
		{"unknown", `"supported_parameters":["reasoning"]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalog := `{"data":[{"id":"other"},{"id":"model",` + tc.fields + `}]}`
			if got := advertisedThinking(strings.NewReader(catalog), "model"); got != tc.want {
				t.Fatalf("got %v", got)
			}
		})
	}
	for _, input := range []string{`{`, `{"data":{}}`, `{"data":[{"id":"model","reasoning":false}]}`} {
		if advertisedThinking(strings.NewReader(input), "model") {
			t.Fatal("accepted invalid metadata")
		}
	}
}

func TestDiscoverThinkingCachesAndRefreshesWithoutGeneration(t *testing.T) {
	calls := 0
	mandatory := false
	p := NewProvider()
	defer p.Close()
	p.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host == "example.com" {
			if r.Method != "POST" || r.URL.Path != "/api/show" {
				t.Fatal("unexpected Ollama discovery request")
			}
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		}
		if r.Method != "GET" || r.URL.String() != "https://openrouter.ai/api/v1/models" || r.Header.Get("Authorization") != "Bearer secret" || r.ContentLength > 0 {
			t.Fatal("unexpected metadata request")
		}
		data := fmt.Sprintf(`{"data":[{"id":"model","reasoning":{"mandatory":%t},"supported_parameters":["reasoning","response_format","structured_outputs"]}]}`, mandatory)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(data))}, nil
	})
	c := Configuration{URL: "https://openrouter.ai/api/v1", Model: "model", Key: "secret"}
	first := p.DiscoverThinking(context.Background(), c, false)
	second := p.DiscoverThinking(context.Background(), c, false)
	if !first || !second || calls != 1 {
		t.Fatal("not cached")
	}
	if configured := p.WithCapabilities(context.Background(), c, false); !configured.StructuredOutput || !configured.ThinkingControllable || calls != 1 {
		t.Fatal("capabilities not shared by one cached metadata lookup")
	}
	mandatory = true
	if p.DiscoverThinking(context.Background(), c, true) || calls != 2 {
		t.Fatal("refresh ignored")
	}
	c.Model = "openrouter/free"
	if p.DiscoverThinking(context.Background(), c, true) || calls != 2 {
		t.Fatal("router treated as fixed model")
	}
	c.URL = "https://example.com/v1"
	if p.DiscoverThinking(context.Background(), c, true) || calls != 3 {
		t.Fatal("unknown provider advertised control")
	}
}

func TestReasoningRequestOnlyForControllableOpenRouterModels(t *testing.T) {
	for _, mode := range []string{"on", "off", "unknown", "generic"} {
		t.Run(mode, func(t *testing.T) {
			p := NewProvider()
			defer p.Close()
			enabled := mode == "on"
			c := Configuration{URL: "https://openrouter.ai/api/v1", Model: "model", ThinkingControllable: mode != "unknown", Thinking: &enabled}
			if mode == "generic" {
				c.URL = "https://example.com/v1"
			}
			p.client.Transport = providerTestTransport(func(r *http.Request) (*http.Response, error) {
				var body struct {
					Reasoning *reasoningRequest `json:"reasoning"`
					MaxTokens *int              `json:"max_tokens"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if mode == "on" || mode == "off" {
					if body.Reasoning == nil || body.Reasoning.Enabled != enabled {
						t.Fatal("wrong reasoning setting")
					}
				} else if body.Reasoning != nil {
					t.Fatal("sent unsupported parameter")
				}
				if body.MaxTokens != nil {
					t.Fatal("normal output capped")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}]}`))}, nil
			})
			if _, _, _, err := p.Complete(context.Background(), c, []Message{{Role: "user", Content: "hello"}}, 0); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestJobFreezesThinkingPerTurnAndRejectsUnsupported(t *testing.T) {
	for _, supported := range []bool{false, true} {
		m := NewManager()
		defer m.Stop()
		s, err := m.Create("owner", "note", "none", "", Configuration{ThinkingControllable: supported})
		if err != nil {
			t.Fatal(err)
		}
		if s.ThinkingControllable != supported {
			t.Fatal("session view lost thinking capability")
		}
		if !supported {
			if _, err := m.PlanTurn(s.ID, "owner", "hello", 0, true); err == nil {
				t.Fatal("unsupported thinking accepted")
			}
			continue
		}
		for _, enabled := range []bool{false, true} {
			current, _ := m.Metadata(s.ID, "owner")
			plan, err := m.PlanTurn(s.ID, "owner", "hello", current.Version, enabled)
			if err != nil {
				t.Fatal(err)
			}
			seen := make(chan bool, 1)
			_, err = m.StartJob(s.ID, "owner", plan.ID, current.Version, func(_ context.Context, c Configuration, _ []Message, _, _, _ string) (Reply, error) {
				seen <- c.Thinking != nil && *c.Thinking == enabled
				return Reply{Answer: "Ready"}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if job := waitJob(t, m, s.ID); job.Status != "completed" {
				t.Fatal(job.Error)
			}
			if !<-seen {
				t.Fatal("thinking changed after planning")
			}
		}
	}
}
