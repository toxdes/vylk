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

func TestLargeReasoningStreamDoesNotConsumeTheAnswerBudget(t *testing.T) {
	frame := `data: {"id":"generation","model":"test-model","provider":"provider","choices":[{"index":0,"delta":{"content":"","reasoning":"checking the draft","reasoning_details":[{"type":"reasoning.text","text":"checking the draft","format":"unknown","index":0}]},"finish_reason":null}]}` + "\n\n"
	content := `{"answer":"Review","changes":[{"id":"b0_0","before":"He go home.","after":"He went home."}]}`
	wire := strings.Repeat(frame, 5000) + streamChunk(content, "stop") + `data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":6000,"completion_tokens_details":{"reasoning_tokens":5900}}}` + "\n\ndata: [DONE]\n\n"
	if len(wire) <= MaxHistory {
		t.Fatal("fixture does not exceed the former wire limit")
	}
	var output bytes.Buffer
	p := &Provider{client: &http.Client{Transport: providerTestTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(wire))}, nil
	})}, debug: &providerDebugLogger{logger: log.New(&output, "", 0), limit: 16 << 20}}
	reply, _, usage, err := p.Complete(context.Background(), Configuration{URL: "https://provider.invalid", Model: "model"}, nil, 0)
	if err != nil || len(reply.Changes) != 1 || reply.Changes[0].After != "He went home." || usage.Output == nil || *usage.Output != 6000 || usage.OutputDetails.Reasoning == nil || *usage.OutputDetails.Reasoning != 5900 {
		t.Fatal(reply, usage, err)
	}
	if output.Len() > 160<<10 {
		t.Fatal("debugging retained the entire stream", output.Len())
	}
	var sawPrefix, sawAnswer, sawTimings bool
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var entry providerDebugEntry
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "ai_debug ")), &entry); err != nil {
			t.Fatal(err)
		}
		if entry.Phase == "response" {
			sawPrefix = len(entry.Body) == maxDebugStreamCapture && entry.OmittedBytes == int64(len(wire)-maxDebugStreamCapture)
		}
		if entry.Phase == "result" && entry.Timings != nil && entry.Timings.Streamed && entry.Model == "test-model" && entry.Provider == "provider" && entry.Timings.FirstReasoningMS != nil && entry.Timings.FirstContentMS != nil && entry.Usage != nil && entry.Usage.OutputDetails.Reasoning != nil && *entry.Usage.OutputDetails.Reasoning == 5900 {
			sawTimings = true
		}
		if entry.Phase == "answer" {
			sawAnswer = entry.Body == content
		}
	}
	if !sawTimings {
		t.Fatal("stream timing and token diagnostics were not reported")
	}
	if !sawPrefix || !sawAnswer {
		t.Fatal("missing bounded prefix or final answer")
	}
}

type repeatingStreamReader struct {
	frame  string
	offset int
}

func (r *repeatingStreamReader) Read(p []byte) (int, error) {
	n := copy(p, r.frame[r.offset:])
	r.offset = (r.offset + n) % len(r.frame)
	return n, nil
}

func TestStreamTransportAndAnswerLimitsAreIndependent(t *testing.T) {
	for _, tc := range []struct {
		name string
		body io.Reader
		want string
	}{
		{"wire limit", &repeatingStreamReader{frame: ": PROCESSING " + strings.Repeat(" ", 4096) + "\n\n"}, "32 MiB transport limit"},
		{"answer limit", strings.NewReader(streamChunk(strings.Repeat("x", MaxContext+1), "stop") + "data: [DONE]\n\n"), "reply exceeds 256 KiB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &Provider{client: &http.Client{Transport: providerTestTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(tc.body)}, nil
			})}}
			_, _, _, err := p.Complete(context.Background(), Configuration{URL: "https://provider.invalid", Model: "model"}, nil, 0)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatal("wrong limit applied", err)
			}
		})
	}
}

func TestOpenRouterStreamsBlockChangesWithoutAnApplicationTokenCap(t *testing.T) {
	content := `{"answer":"Review","changes":[{"id":"b0_0","before":"He go home.","after":"He went home."}]}`
	p := &Provider{client: &http.Client{Transport: providerTestTransport(func(r *http.Request) (*http.Response, error) {
		var input struct {
			Stream    bool   `json:"stream"`
			MaxTokens *int   `json:"max_tokens"`
			Model     string `json:"model"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || !input.Stream || input.MaxTokens != nil || input.Model != "nvidia/nemotron-3.5-lightning:free" {
			t.Error("wrong request format", input)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(streamChunk(content, "stop") + "data: [DONE]\n\n"))}, nil
	})}}
	reply, _, _, err := p.Complete(context.Background(), Configuration{URL: "https://openrouter.ai/api/v1", Model: "nvidia/nemotron-3.5-lightning:free"}, nil, 0)
	if err != nil || len(reply.Changes) != 1 || reply.Changes[0].After != "He went home." {
		t.Fatal(reply, err)
	}
}

func streamChunk(content, finish string) string {
	data, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": content}, "finish_reason": finish}}})
	return "data: " + string(data) + "\n\n"
}

func TestStreamRequiresCompletionAndPreservesFinalAccounting(t *testing.T) {
	content := `{"answer":"Ready","changes":[]}`
	stream := ": OPENROUTER PROCESSING\n\n" + streamChunk(content[:12], "") + streamChunk(content[12:], "stop") + `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":200,"total_tokens":300,"completion_tokens_details":{"reasoning_tokens":150}}}` + "\n\ndata: [DONE]\n\n"
	e, err := readCompletionStream(strings.NewReader(stream))
	if err != nil || len(e.Choices) != 1 || e.Choices[0].Message.Content != content || e.Choices[0].Finish != "stop" || e.Usage.Total == nil || *e.Usage.Total != 300 || e.Usage.OutputDetails.Reasoning == nil || *e.Usage.OutputDetails.Reasoning != 150 {
		t.Fatal("stream content or usage changed", e, err)
	}
	for _, invalid := range []string{
		streamChunk(content, "stop"),
		streamChunk(content, "stop") + streamChunk("unexpected", "") + "data: [DONE]\n\n",
		streamChunk(content, "stop") + streamChunk("", "length") + "data: [DONE]\n\n",
		"data: not-json\n\ndata: [DONE]\n\n",
		`data: {"error":{"code":"context_length_exceeded","message":"secret raw note"}}` + "\n\n",
	} {
		if _, err := readCompletionStream(strings.NewReader(invalid)); err == nil || strings.Contains(err.Error(), "secret raw note") {
			t.Fatal("accepted invalid stream or leaked provider data", err)
		}
	}
}
