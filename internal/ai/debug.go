package ai

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// Shared across manager restarts so toggling AI cannot reset the per-process
// debug budget. No log files or background workers are owned by this package.
var providerDebugOutput = &providerDebugLogger{logger: log.Default(), limit: 16 << 20}

type providerDebugLogger struct {
	mu        sync.Mutex
	logger    *log.Logger
	limit     int
	written   int
	exhausted bool
}

type providerDebugExchange struct {
	output          *providerDebugLogger
	id              string
	key             string
	started         time.Time
	timings         providerDebugTimings
	model, provider string
	call            debugCall
}

type providerDebugEntry struct {
	TurnID            string                 `json:"turn_id,omitempty"`
	Attempt           int                    `json:"attempt,omitempty"`
	RequestID         string                 `json:"request_id"`
	Phase             string                 `json:"phase"`
	ElapsedMS         int64                  `json:"elapsed_ms"`
	Status            int                    `json:"http_status,omitempty"`
	Body              string                 `json:"body,omitempty"`
	Error             string                 `json:"error,omitempty"`
	Progress          *providerDebugProgress `json:"progress,omitempty"`
	ProviderRequestID string                 `json:"provider_request_id,omitempty"`
	ContentType       string                 `json:"content_type,omitempty"`
	OmittedBytes      int64                  `json:"omitted_bytes,omitempty"`
	Timings           *providerDebugTimings  `json:"timings,omitempty"`
	Usage             *Usage                 `json:"usage,omitempty"`
	Model             string                 `json:"model,omitempty"`
	Provider          string                 `json:"provider,omitempty"`
}

type debugQueueKey struct{}

type providerDebugTimings struct {
	Inference        *providerInferenceTimings `json:"inference,omitempty"`
	QueueWaitMS      *int64                    `json:"queue_wait_ms,omitempty"`
	Streamed         bool                      `json:"streamed"`
	HeadersMS        *int64                    `json:"headers_ms,omitempty"`
	FirstReasoningMS *int64                    `json:"first_reasoning_ms,omitempty"`
	FirstContentMS   *int64                    `json:"first_content_ms,omitempty"`
}

// Read reasoning metadata only until the first meaningful delta is observed.
// The ordinary stream parser does no extra reasoning decoding when debug is off.
func (d *providerDebugExchange) observeStream(data []byte, content string) {
	if d.timings.FirstReasoningMS == nil && d.timings.FirstContentMS == nil {
		var frame struct {
			Model    string `json:"model"`
			Provider string `json:"provider"`
			Choices  []struct {
				Delta struct {
					Reasoning        string            `json:"reasoning"`
					ReasoningContent string            `json:"reasoning_content"`
					ReasoningDetails []json.RawMessage `json:"reasoning_details"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal(data, &frame) == nil && len(frame.Choices) == 1 {
			if d.model == "" && len(frame.Model) <= 256 {
				d.model = frame.Model
			}
			if d.provider == "" && len(frame.Provider) <= 256 {
				d.provider = frame.Provider
			}
			delta := frame.Choices[0].Delta
			if strings.TrimSpace(delta.Reasoning) != "" || strings.TrimSpace(delta.ReasoningContent) != "" || len(delta.ReasoningDetails) > 0 {
				elapsed := time.Since(d.started).Milliseconds()
				d.timings.FirstReasoningMS = &elapsed
				d.emit(providerDebugEntry{Phase: "first_reasoning", Model: d.model, Provider: d.provider}, nil)
			}
		}
	}
	if d.timings.FirstContentMS == nil && strings.TrimSpace(content) != "" {
		elapsed := time.Since(d.started).Milliseconds()
		d.timings.FirstContentMS = &elapsed
		d.emit(providerDebugEntry{Phase: "first_content", Model: d.model, Provider: d.provider}, nil)
	}
}

// Capture a prefix for transport debugging without retaining the whole reasoning
// stream. The assembled final answer is logged separately after completion.
type providerDebugCapture struct {
	buffer bytes.Buffer
	total  int64
}

const maxDebugStreamCapture = 64 << 10

func (c *providerDebugCapture) Write(p []byte) (int, error) {
	c.total += int64(len(p))
	if remaining := maxDebugStreamCapture - c.buffer.Len(); remaining > 0 {
		_, _ = c.buffer.Write(p[:min(len(p), remaining)])
	}
	return len(p), nil
}

type providerDebugProgress struct {
	ReceivedBytes      int64 `json:"received_bytes"`
	NonWhitespaceBytes int64 `json:"non_whitespace_bytes"`
}

type providerDebugReader struct {
	source     io.Reader
	debug      *providerDebugExchange
	progress   providerDebugProgress
	lastLogged time.Time
}

// Observe reads only while debugging. No timers, workers, or chunk buffering:
// silence means no newly observed bytes, and the request deadline still applies.
func (r *providerDebugReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	if n > 0 {
		previousContent := r.progress.NonWhitespaceBytes
		r.progress.ReceivedBytes += int64(n)
		for _, b := range p[:n] {
			if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
				r.progress.NonWhitespaceBytes++
			}
		}
		now := time.Now()
		if r.lastLogged.IsZero() || now.Sub(r.lastLogged) >= 10*time.Second || (previousContent == 0 && r.progress.NonWhitespaceBytes > 0) {
			r.debug.emit(providerDebugEntry{Phase: "body_progress", Progress: &r.progress}, nil)
			r.lastLogged = now
		}
	}
	return n, err
}

func configuredProviderDebug() *providerDebugLogger {
	if os.Getenv("VYLK_AI_DEBUG") == "1" {
		return providerDebugOutput
	}
	return nil
}

func (d *providerDebugExchange) write(phase string, body []byte, status int, err error) {
	if d == nil {
		return
	}
	d.emit(providerDebugEntry{Phase: phase, Status: status, Body: string(body)}, err)
}

func (d *providerDebugExchange) emit(entry providerDebugEntry, err error) {
	if d == nil {
		return
	}
	o := d.output
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.exhausted {
		return
	}
	entry.RequestID = d.id
	entry.TurnID = d.call.TurnID
	entry.Attempt = d.call.Attempt
	entry.ElapsedMS = time.Since(d.started).Milliseconds()
	if err != nil {
		entry.Error = err.Error()
	}
	// Bodies can contain a reflected credential even though headers are never
	// logged. Redact both plain and JSON-escaped forms before encoding the entry.
	if d.key != "" {
		forms := []string{d.key}
		for range 3 {
			encoded, _ := json.Marshal(forms[len(forms)-1])
			forms = append(forms, string(encoded[1:len(encoded)-1]))
		}
		pairs := make([]string, 0, len(forms)*2)
		for i := len(forms) - 1; i >= 0; i-- {
			pairs = append(pairs, forms[i], "[REDACTED]")
		}
		redactor := strings.NewReplacer(pairs...)
		entry.TurnID = redactor.Replace(entry.TurnID)
		entry.Body = redactor.Replace(entry.Body)
		entry.Error = redactor.Replace(entry.Error)
		entry.ProviderRequestID = redactor.Replace(entry.ProviderRequestID)
		entry.ContentType = redactor.Replace(entry.ContentType)
		entry.Model = redactor.Replace(entry.Model)
		entry.Provider = redactor.Replace(entry.Provider)
	}
	data, _ := json.Marshal(entry)
	if len(data)+1 > o.limit-o.written {
		o.exhausted = true
		o.logger.Print("ai_debug: debug output budget exhausted; restart the server to capture more")
		return
	}
	o.written += len(data) + 1
	o.logger.Printf("ai_debug %s", data)
}
