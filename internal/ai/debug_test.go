package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type providerDebugWriter func([]byte) (int, error)

func (f providerDebugWriter) Write(p []byte) (int, error) { return f(p) }

func TestProviderDebugReportsHeartbeatBeforeResponseCompletes(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	entries := make(chan providerDebugEntry, 16)
	logger := log.New(providerDebugWriter(func(p []byte) (int, error) {
		var entry providerDebugEntry
		if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(string(p)), "ai_debug ")), &entry); err != nil {
			return 0, err
		}
		entries <- entry
		return len(p), nil
	}), "", 0)
	p := &Provider{
		client: &http.Client{Transport: providerTestTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: reader, Header: make(http.Header)}, nil
		})},
		debug: &providerDebugLogger{logger: logger, limit: 16 << 10},
	}
	done := make(chan error, 1)
	go func() {
		_, _, _, err := p.Complete(context.Background(), Configuration{URL: "https://provider.invalid", Model: "model"}, nil, 0)
		done <- err
	}()
	nextProgress := func() providerDebugProgress {
		t.Helper()
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		for {
			select {
			case entry := <-entries:
				if entry.Phase == "body_progress" && entry.Progress != nil {
					return *entry.Progress
				}
			case <-timer.C:
				t.Fatal("progress was withheld until the response finished")
				return providerDebugProgress{}
			}
		}
	}
	if _, err := writer.Write([]byte("\n ")); err != nil {
		t.Fatal(err)
	}
	heartbeat := nextProgress()
	if heartbeat.ReceivedBytes != 2 || heartbeat.NonWhitespaceBytes != 0 {
		t.Fatal("heartbeat was mistaken for content", heartbeat)
	}
	select {
	case err := <-done:
		t.Fatal("request ended before response completion", err)
	default:
	}
	envelope := `{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}]}`
	if _, err := writer.Write([]byte(envelope)); err != nil {
		t.Fatal(err)
	}
	content := nextProgress()
	if content.NonWhitespaceBytes == 0 || content.ReceivedBytes != int64(2+len(envelope)) {
		t.Fatal("first content was throttled or bytes changed", content)
	}
	_ = writer.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("debugging changed response parsing", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("response did not complete")
	}
}

func TestProviderDebugRequiresExplicitOptIn(t *testing.T) {
	for _, value := range []string{"", "0", "true", "1"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("VYLK_AI_DEBUG", value)
			p := NewProvider()
			defer p.Close()
			if (p.debug != nil) != (value == "1") {
				t.Fatal("unexpected debug configuration")
			}
		})
	}
}

func TestProviderDebugCapturesRawFailureWithoutCredentials(t *testing.T) {
	for _, key := range []string{"sk-or-v1-private-test-key", "sk-private\"quoted\\key"} {
		t.Run(key, func(t *testing.T) {
			var output bytes.Buffer
			var envelope []byte
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Generation-Id", "gen-debug-test")
				if r.Header.Get("Authorization") != "Bearer "+key {
					t.Error("provider did not receive the actual credential")
				}
				// The model emits an incomplete schema and reflects a key inside its
				// JSON-encoded content, exercising the raw debugging path.
				content, _ := json.Marshal(map[string]string{"answer": key})
				envelope, _ = json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}, "finish_reason": "stop"}}})
				_, _ = w.Write(envelope)
			}))
			defer server.Close()
			p := NewProvider()
			defer p.Close()
			p.debug = &providerDebugLogger{logger: log.New(&output, "", 0), limit: 16 << 20}
			_, _, _, err := p.Complete(context.Background(), Configuration{URL: server.URL, Key: key, Model: "test-model"}, []Message{{Role: "user", Content: "Debug this draft\n" + key}}, 0)
			if err == nil {
				t.Fatal("malformed structured reply was accepted")
			}
			lines := strings.Split(strings.TrimSpace(output.String()), "\n")
			if len(lines) < 5 {
				t.Fatal("missing request/headers/progress/response/result events", output.String())
			}
			var requestID string
			for i, line := range lines {
				var entry providerDebugEntry
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "ai_debug ")), &entry); err != nil {
					t.Fatal("log entry is not safe single-line JSON", err)
				}
				if i == 0 {
					requestID = entry.RequestID
				}
				if entry.RequestID == "" || entry.RequestID != requestID {
					t.Fatal("lost request correlation")
				}
				if strings.Contains(entry.Body, key) || strings.Contains(entry.Body, "Authorization") || strings.Contains(entry.Body, "Bearer ") {
					t.Fatal("credential or headers leaked")
				}
				switch entry.Phase {
				case "response_headers":
					if entry.ProviderRequestID != "gen-debug-test" {
						t.Fatal("missing provider correlation ID")
					}
				case "request":
					if !strings.Contains(entry.Body, "Debug this draft") || !strings.Contains(entry.Body, "[REDACTED]") {
						t.Fatal("missing redacted request")
					}
				case "response":
					if entry.Status != 200 || !strings.Contains(entry.Body, "[REDACTED]") || !strings.Contains(entry.Body, "finish_reason") {
						t.Fatal("missing raw redacted response")
					}
				case "body_progress":
					if entry.Progress == nil || entry.Progress.ReceivedBytes <= 0 || entry.Body != "" {
						t.Fatal("missing body counters or leaked chunk content")
					}
				case "result":
					if !strings.Contains(entry.Error, "invalid structured output") {
						t.Fatal("missing validation failure")
					}
				}
			}
		})
	}
}

func TestProviderDebugStopsAtItsBudget(t *testing.T) {
	var output bytes.Buffer
	o := &providerDebugLogger{logger: log.New(&output, "", 0), limit: 1024}
	d := &providerDebugExchange{output: o, id: "request", started: time.Now()}
	for range 20 {
		d.write("request", []byte(strings.Repeat("x", 200)), 0, nil)
	}
	if !o.exhausted || o.written > o.limit || output.Len() > 1200 || strings.Count(output.String(), "budget exhausted") != 1 {
		t.Fatal("unbounded debug output", o.written, output.Len())
	}
}

func TestStreamDebugDistinguishesReasoningFromContent(t *testing.T) {
	d := &providerDebugExchange{started: time.Now().Add(-time.Second), output: &providerDebugLogger{logger: log.New(io.Discard, "", 0), limit: 4096}}
	reasoning := []byte(`{"choices":[{"delta":{"content":"","reasoning":"Checking the note"}}]}`)
	d.observeStream(reasoning, "")
	if d.timings.FirstReasoningMS == nil || d.timings.FirstContentMS != nil {
		t.Fatal(d.timings)
	}
	first := *d.timings.FirstReasoningMS
	time.Sleep(time.Millisecond)
	d.observeStream(reasoning, "")
	if *d.timings.FirstReasoningMS != first {
		t.Fatal("first reasoning timestamp changed")
	}
	d.observeStream([]byte(`{"choices":[{"delta":{"content":"{}"}}]}`), "{}")
	if d.timings.FirstContentMS == nil || *d.timings.FirstContentMS < first {
		t.Fatal(d.timings)
	}
}
