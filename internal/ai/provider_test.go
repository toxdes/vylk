package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type providerTestTransport func(*http.Request) (*http.Response, error)

func (f providerTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type providerErrorReader struct{ err error }

func (r providerErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestProviderDistinguishesTransportTimeoutFromCancellation(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want error
	}{
		{"timeout", context.DeadlineExceeded, ErrTimeout},
		{"cancellation", context.Canceled, ErrCancelled},
	} {
		for _, bodyStarted := range []bool{false, true} {
			t.Run(tc.name+map[bool]string{false: " before headers", true: " during body"}[bodyStarted], func(t *testing.T) {
				p := &Provider{client: &http.Client{Transport: providerTestTransport(func(*http.Request) (*http.Response, error) {
					if !bodyStarted {
						return nil, tc.err
					}
					return &http.Response{StatusCode: 200, Body: io.NopCloser(providerErrorReader{tc.err}), Header: make(http.Header)}, nil
				})}}
				_, _, _, err := p.Complete(context.Background(), Configuration{URL: "https://provider.invalid", Model: "model"}, nil, 0)
				if !errors.Is(err, tc.want) {
					t.Fatal("incorrect transport error classification", err)
				}
			})
		}
	}
}

func TestIncompleteResponsesExplainTheCauseAndPreserveUsage(t *testing.T) {
	for _, tc := range []struct {
		name, finish, content, want string
		reasoning                   int
	}{
		{"reasoning exhausted budget", "length", "", "128-token response limit for reasoning", 128},
		{"truncated structured output", "length", `{"answer":"unfinished`, "128-token response limit before completing", 0},
		{"filtered", "content_filter", "", "provider blocked", 0},
		{"tools", "tool_calls", "", "does not run tools", 0},
		{"upstream failure", "error", "", "provider failed", 0},
		{"untrusted status", "secret status with credentials", "", "unsupported completion status", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var request struct {
					Model     string `json:"model"`
					MaxTokens int    `json:"max_tokens"`
				}
				if json.NewDecoder(r.Body).Decode(&request) != nil || request.MaxTokens != 128 || request.Model != "nvidia/nemotron-3.5-lightning:free" {
					t.Error("unexpected model or token budget")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": tc.content}, "finish_reason": tc.finish}}, "usage": map[string]any{"completion_tokens": 128, "completion_tokens_details": map[string]int{"reasoning_tokens": tc.reasoning}}})
			}))
			defer server.Close()
			provider := NewProvider()
			defer provider.Close()
			reply, _, usage, err := provider.Complete(context.Background(), Configuration{URL: server.URL, Model: "nvidia/nemotron-3.5-lightning:free"}, []Message{{Role: "user", Content: "Ready"}}, 128)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("unexpected error: %v", err)
			}
			if strings.Contains(err.Error(), "secret status") {
				t.Fatal("untrusted provider status exposed")
			}
			if calls != 1 || usage.Output == nil || *usage.Output != 128 || usage.OutputDetails.Reasoning == nil || *usage.OutputDetails.Reasoning != int64(tc.reasoning) {
				t.Fatal("usage lost or request retried", calls, usage)
			}
			if reply.Answer != "" || len(reply.Edits) > 0 {
				t.Fatal("incomplete output was accepted")
			}
		})
	}
}

func TestProviderChosenTokenLimitStillRequiresCompleteStructuredOutput(t *testing.T) {
	for _, tc := range []struct {
		name, content, finish, wantError string
		reasoning                        int
	}{
		{"complete", `{"answer":"Ready","changes":[]}`, "stop", "", 0},
		{"length even with valid JSON", `{"answer":"Ready","changes":[]}`, "length", "provider's response limit", 0},
		{"reasoning only", "", "length", "provider's response limit for reasoning", 128},
		{"fenced JSON", "```json\n{\"answer\":\"Ready\",\"changes\":[]}\n```", "stop", "invalid structured output", 0},
		{"missing replacement", `{"answer":"Ready","edits":[{"before":"task"}]}`, "stop", "invalid structured output", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var input map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
				}
				for _, key := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
					if _, exists := input[key]; exists {
						t.Error("sent an application token limit", key)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": tc.content}, "finish_reason": tc.finish}}, "usage": map[string]any{"completion_tokens": 128, "completion_tokens_details": map[string]int{"reasoning_tokens": tc.reasoning}}})
			}))
			defer server.Close()
			p := NewProvider()
			defer p.Close()
			reply, _, usage, err := p.Complete(context.Background(), Configuration{URL: server.URL, Model: "openrouter/free"}, []Message{{Role: "user", Content: "hello"}}, 0)
			if tc.wantError == "" {
				if err != nil || reply.Answer != "Ready" {
					t.Fatal(reply, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatal("unexpected error", err)
			}
			if calls != 1 || usage.Output == nil || *usage.Output != 128 {
				t.Fatal("usage lost or request retried", calls, usage)
			}
		})
	}
}
