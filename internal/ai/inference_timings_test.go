package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
)

func TestInferenceTimingsPreserveUnknownZeroAndProviderRates(t *testing.T) {
	for _, raw := range []string{"", `null`, `{}`, `"unsupported"`, `{"prompt_ms":"bad"}`} {
		if got := inferenceTimings(json.RawMessage(raw)); got != nil {
			t.Fatal(raw, got)
		}
	}
	got := inferenceTimings(json.RawMessage(`{"cache_n":0,"prompt_n":20,"prompt_ms":80,"predicted_n":6,"predicted_ms":120}`))
	if got == nil || got.CachedTokens == nil || *got.CachedTokens != 0 || *got.PromptRate != 250 || *got.OutputRate != 50 {
		t.Fatal(got)
	}
	got = inferenceTimings(json.RawMessage(`{"prompt_n":20,"prompt_ms":80,"prompt_per_second":200,"predicted_n":-1,"predicted_ms":-1}`))
	if got == nil || *got.PromptRate != 200 || got.OutputTokens != nil || got.OutputMS != nil || got.CachedTokens != nil {
		t.Fatal(got)
	}
	got = inferenceTimings(json.RawMessage(`{"prompt_n":20,"prompt_ms":1e-320}`))
	if got == nil || got.PromptRate != nil {
		t.Fatal("derived a non-finite rate", got)
	}
}

func TestProviderDiagnosticsCaptureInferenceTimingsWithoutChangingReplies(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		for _, telemetry := range []string{`{"cache_n":64,"prompt_n":20,"prompt_ms":80,"predicted_n":6,"predicted_ms":120}`, `{"prompt_ms":"bad"}`} {
			var output bytes.Buffer
			p := NewProvider()
			p.debug = &providerDebugLogger{logger: log.New(&output, "", 0), limit: 1 << 20}
			p.client.Transport = providerTestTransport(func(*http.Request) (*http.Response, error) {
				header := http.Header{"Content-Type": []string{"application/json"}}
				body := `{"choices":[{"message":{"content":"{\"answer\":\"Ready\",\"changes\":[]}"},"finish_reason":"stop"}],"timings":` + telemetry + `}`
				if streaming {
					header.Set("Content-Type", "text/event-stream")
					body = streamChunk(`{"answer":"Ready","changes":[]}`, "stop") + `data: {"choices":[],"timings":` + telemetry + "}\n\ndata: [DONE]\n\n"
				}
				return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			ctx := context.WithValue(context.Background(), debugCallKey{}, debugCall{TurnID: "turn", Attempt: 2})
			reply, _, _, err := p.Complete(ctx, Configuration{URL: "http://provider.invalid/v1", Model: "selected"}, nil, 0)
			p.Close()
			if err != nil || reply.Answer != "Ready" {
				t.Fatal("telemetry affected answer", err)
			}
			found := false
			for line := range strings.SplitSeq(strings.TrimSpace(output.String()), "\n") {
				var entry providerDebugEntry
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "ai_debug ")), &entry) != nil {
					t.Fatal(line)
				}
				if entry.Phase != "result" {
					continue
				}
				found = true
				if entry.TurnID != "turn" || entry.Attempt != 2 || entry.Model != "selected" {
					t.Fatal(entry)
				}
				metrics := entry.Timings.Inference
				if strings.Contains(telemetry, "bad") {
					if metrics != nil {
						t.Fatal("accepted unusable timing data")
					}
				} else if metrics == nil || *metrics.CachedTokens != 64 || *metrics.PromptRate != 250 || *metrics.OutputRate != 50 {
					t.Fatal(metrics)
				}
			}
			if !found {
				t.Fatal("missing result diagnostics")
			}
		}
	}
}

func TestCorrectionDiagnosticsShareTurnAndIdentifyEachAttempt(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	m.Provider.debug = &providerDebugLogger{logger: log.New(io.Discard, "", 0), limit: 1 << 20}
	calls := 0
	_, err := m.CompleteWithFeedback(context.Background(), Configuration{}, feedbackRequest(), "note", "session", "turn", func(ctx context.Context, _ Configuration, _ []Message, _, _, _ string) (Reply, error) {
		calls++
		call, ok := ctx.Value(debugCallKey{}).(debugCall)
		if !ok || call.TurnID != "turn" || call.Attempt != calls {
			t.Fatal("lost call correlation", call)
		}
		if calls == 1 {
			return Reply{}, &OutputError{Reason: "invalid output", raw: "bad"}
		}
		return Reply{Answer: NoChangesAnswer, Changes: []BlockChange{}}, nil
	}, func(Reply) error { return nil })
	if err != nil || calls != 2 {
		t.Fatal(err, calls)
	}
}
