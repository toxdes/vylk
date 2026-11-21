// Package ai owns bounded, temporary AI drafts and OpenAI-compatible transport.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const MaxSnapshot = 1 << 20

// Used when neither the configuration nor the provider states a window. Most
// current OpenAI-compatible models serve at least this; users can edit it.
const DefaultContextTokens = 32768
const MinContextTokens = 2048
const MaxContextTokens = 16 << 20
const MaxConcurrency = 8
const MaxContext = 256 << 10
const MaxHistory = 1 << 20
const Timeout = 10 * time.Minute

var ErrTimeout = errors.New("AI request timed out after ten minutes; try a smaller selection or another model")
var ErrCancelled = errors.New("AI request cancelled")

type Configuration struct {
	OutputProfile        string `json:"output_profile"`
	StructuredOutput     bool   `json:"-"`
	Ollama               bool   `json:"-"`
	Thinking             *bool  `json:"-"`
	ThinkingControllable bool   `json:"-"`
	ThinkingEffort       string `json:"-"`
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	URL                  string `json:"url"`
	Key                  string `json:"-"`
	Model                string `json:"model"`
	HasKey               bool   `json:"has_key"`
	Checked              bool   `json:"checked"`
	Default              bool   `json:"is_default"`
	Revision             int64  `json:"revision"`
	// Zero means unset: planning uses the provider-reported window, then
	// DefaultContextTokens; concurrency uses the server default.
	ContextTokens int `json:"context_tokens"`
	Concurrency   int `json:"concurrency"`
}

func ValidText(s string, max int) bool {
	return utf8.ValidString(s) && len(s) <= max && !strings.ContainsRune(s, 0)
}

func (c Configuration) Validate() error {
	if c.OutputProfile != "" && c.OutputProfile != "json_schema" {
		return errors.New("unsupported output profile")
	}
	if c.ContextTokens != 0 && (c.ContextTokens < MinContextTokens || c.ContextTokens > MaxContextTokens) {
		return fmt.Errorf("context window must be from %d to %d tokens", MinContextTokens, MaxContextTokens)
	}
	if c.Concurrency < 0 || c.Concurrency > MaxConcurrency {
		return fmt.Errorf("parallel requests must be from 1 to %d", MaxConcurrency)
	}
	for _, field := range []struct {
		value string
		limit int
	}{{c.Name, 120}, {c.Model, 256}, {c.URL, 2048}} {
		if !ValidText(field.value, field.limit) || strings.TrimSpace(field.value) == "" || strings.IndexFunc(field.value, unicode.IsControl) >= 0 {
			return errors.New("name, URL, and model must be non-empty and contain no control characters")
		}
	}
	if !ValidText(c.Key, 16<<10) || strings.IndexFunc(c.Key, unicode.IsControl) >= 0 {
		return errors.New("invalid API key")
	}
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return errors.New("enter an HTTP or HTTPS API base URL without credentials, query, or fragment")
	}
	return nil
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type Edit struct {
	Before string `json:"before"`
	After  string `json:"after"`
}

func (e *Edit) UnmarshalJSON(data []byte) error {
	var fields struct {
		Before *string `json:"before"`
		After  *string `json:"after"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&fields) != nil || fields.Before == nil || fields.After == nil {
		return errors.New("edits require before and after strings")
	}
	e.Before, e.After = *fields.Before, *fields.After
	return nil
}

type Reply struct {
	finishUsage func(error) error
	raw         string
	Changes     []BlockChange `json:"changes,omitempty"`
	Answer      string        `json:"answer"`
	Edits       []Edit        `json:"edits"`
	Replacement *string       `json:"replacement,omitempty"`
	Tools       []ToolCall    `json:"-"`
}
type Usage struct {
	Input        *int64 `json:"prompt_tokens"`
	Output       *int64 `json:"completion_tokens"`
	Total        *int64 `json:"total_tokens"`
	InputDetails struct {
		Cached *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	OutputDetails struct {
		Reasoning *int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

type Provider struct {
	client    *http.Client
	debug     *providerDebugLogger
	contextMu sync.Mutex
	contexts  map[[32]byte]modelContext
	reasoning map[[32]byte]reasoningCapability
}

func NewProvider(concurrency ...int) *Provider {
	limit := 1
	if len(concurrency) > 0 {
		limit = max(1, min(8, concurrency[0]))
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = max(4, limit)
	transport.MaxIdleConnsPerHost = limit
	transport.IdleConnTimeout = 30 * time.Second
	transport.MaxResponseHeaderBytes = 64 << 10
	return &Provider{client: &http.Client{Transport: transport, Timeout: Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, debug: configuredProviderDebug()}
}
func (p *Provider) Close() { p.client.CloseIdleConnections() }

// Complete never retries a potentially billable request or exposes provider error
// bodies. A zero maxTokens leaves the output budget to the provider.
func (p *Provider) Complete(ctx context.Context, c Configuration, messages []Message, maxTokens int) (reply Reply, raw string, usage Usage, resultErr error) {
	format, routing := structuredFormat(c, messages)
	body, err := json.Marshal(struct {
		Model           string            `json:"model"`
		Messages        []Message         `json:"messages"`
		MaxTokens       int               `json:"max_tokens,omitempty"`
		Stream          bool              `json:"stream"`
		Reasoning       *reasoningRequest `json:"reasoning,omitempty"`
		ReasoningEffort string            `json:"reasoning_effort,omitempty"`
		ResponseFormat  json.RawMessage   `json:"response_format,omitempty"`
		Provider        *providerRouting  `json:"provider,omitempty"`
	}{c.Model, messages, maxTokens, maxTokens == 0 && openRouterEndpoint(c.URL), reasoningFor(c), ollamaReasoningFor(c), format, routing})
	if err != nil {
		return Reply{}, "", usage, err
	}
	var debug *providerDebugExchange
	if p.debug != nil {
		debug = &providerDebugExchange{output: p.debug, id: ID(), key: c.Key, started: time.Now()}
		if call, ok := ctx.Value(debugCallKey{}).(debugCall); ok {
			debug.call = call
		}
		if queued, ok := ctx.Value(debugQueueKey{}).(int64); ok {
			debug.timings.QueueWaitMS = &queued
		}
		debug.write("request", body, 0, nil)
		defer func() {
			model := debug.model
			if model == "" {
				model = c.Model
			}
			debug.emit(providerDebugEntry{Phase: "result", Timings: &debug.timings, Usage: &usage, Model: model, Provider: debug.provider}, resultErr)
		}()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.URL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Reply{}, "", usage, errors.New("invalid provider URL")
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Key != "" {
		req.Header.Set("Authorization", "Bearer "+c.Key)
	}
	res, err := p.client.Do(req)
	if err != nil {
		debug.write("transport_error", nil, 0, err)
		if errors.Is(err, context.DeadlineExceeded) {
			return Reply{}, "", usage, ErrTimeout
		}
		if errors.Is(err, context.Canceled) {
			return Reply{}, "", usage, ErrCancelled
		}
		return Reply{}, "", usage, errors.New("AI provider connection failed; check the provider and try again")
	}
	defer res.Body.Close()
	if debug != nil {
		elapsed := time.Since(debug.started).Milliseconds()
		debug.timings.HeadersMS = &elapsed
	}
	debug.emit(providerDebugEntry{Phase: "response_headers", Status: res.StatusCode, ProviderRequestID: res.Header.Get("X-Generation-Id"), ContentType: res.Header.Get("Content-Type")}, nil)
	var responseBody io.Reader = res.Body
	if debug != nil {
		responseBody = &providerDebugReader{source: res.Body, debug: debug}
	}
	var envelope completionEnvelope
	limited := &io.LimitedReader{R: responseBody, N: MaxHistory + 1}
	var data []byte
	streamed := res.StatusCode == http.StatusOK && strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream")
	var omittedBytes int64
	if streamed {
		limited.N = MaxStreamBytes + 1
		var capture providerDebugCapture
		var input io.Reader = limited
		if debug != nil {
			input = io.TeeReader(limited, &capture)
		}
		var observe func([]byte, string)
		if debug != nil {
			debug.timings.Streamed = true
			observe = debug.observeStream
		}
		envelope, err = readCompletionStream(input, observe)
		data = capture.buffer.Bytes()
		omittedBytes = capture.total - int64(len(data))
	} else {
		data, err = io.ReadAll(limited)
		if err == nil && res.StatusCode == http.StatusOK {
			err = json.Unmarshal(data, &envelope)
		}
	}
	usage = envelope.Usage
	if debug != nil {
		debug.timings.Inference = inferenceTimings(envelope.Timings)
		debug.emit(providerDebugEntry{Phase: "response", Body: string(data), Status: res.StatusCode, OmittedBytes: omittedBytes}, err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return Reply{}, "", usage, ErrTimeout
	}
	if errors.Is(err, context.Canceled) {
		return Reply{}, "", usage, ErrCancelled
	}
	if streamed && limited.N == 0 {
		return Reply{}, "", usage, errors.New("provider stream exceeded the 32 MiB transport limit before completing its answer; no edits were accepted")
	}
	if !streamed && (limited.N == 0 || len(data) > MaxHistory) {
		return Reply{}, "", usage, errors.New("provider response exceeded the size limit or could not be read")
	}
	if err != nil {
		if streamed {
			return Reply{}, "", usage, err
		}
		return Reply{}, "", usage, errors.New("provider response was incomplete or invalid; no edits were accepted")
	}
	if res.StatusCode != http.StatusOK {
		return Reply{}, "", usage, providerFailure(res.StatusCode, data)
	}
	var failure struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &failure) == nil && len(failure.Error) > 0 && string(failure.Error) != "null" {
		return Reply{}, "", usage, providerFailure(http.StatusBadGateway, data)
	}
	if len(envelope.Choices) != 1 {
		return Reply{}, "", usage, errors.New("provider did not return exactly one completion")
	}
	switch envelope.Choices[0].Finish {
	case "stop":
	case "length":
		limit := "provider's response limit"
		if maxTokens > 0 {
			limit = fmt.Sprintf("%d-token response limit", maxTokens)
		}
		if usage.Output != nil && usage.OutputDetails.Reasoning != nil && *usage.Output > 0 && *usage.OutputDetails.Reasoning >= *usage.Output {
			return Reply{}, "", usage, fmt.Errorf("model used the %s for reasoning before producing an answer", limit)
		}
		return Reply{}, "", usage, fmt.Errorf("model reached the %s before completing its answer", limit)
	case "content_filter":
		return Reply{}, "", usage, errors.New("provider blocked the response; revise the request or choose another model")
	case "tool_calls":
		return Reply{}, "", usage, errors.New("model requested a tool call; AI Assist does not run tools")
	case "error":
		return Reply{}, "", usage, errors.New("provider failed while generating the response; try again manually")
	default:
		return Reply{}, "", usage, errors.New("provider returned an unsupported completion status")
	}
	raw = envelope.Choices[0].Message.Content
	if streamed {
		debug.write("answer", []byte(raw), res.StatusCode, nil)
	}
	var fields struct {
		Answer  *string        `json:"answer"`
		Changes *[]BlockChange `json:"changes"`
		Tools   []ToolCall     `json:"tools"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&fields) != nil || decoder.Decode(&struct{}{}) != io.EOF || fields.Answer == nil || fields.Changes == nil {
		return Reply{}, raw, usage, &OutputError{Reason: "model returned invalid structured output; expected answer and changes with id, before and after strings, without Markdown fences", raw: raw}
	}
	reply = Reply{Answer: *fields.Answer, Changes: *fields.Changes, Tools: fields.Tools, raw: raw}
	if !ValidText(reply.Answer, MaxContext) || len(reply.Changes) > MaxBlockChanges || len(reply.Tools) > maxToolCalls || (strings.TrimSpace(reply.Answer) == "" && len(reply.Changes) == 0 && len(reply.Tools) == 0) {
		return Reply{}, raw, usage, &OutputError{Reason: "model returned invalid structured output; invalid answer or too many changes", raw: raw}
	}
	return reply, raw, usage, nil
}
