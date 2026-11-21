package ai

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type Capabilities struct {
	Controllable bool
	Structured   bool
	ollamaEffort string
	ollama       bool
	capacity     modelContext
}

type reasoningCapability struct {
	Capabilities
	Expires time.Time
}

type reasoningRequest struct {
	Enabled bool `json:"enabled"`
}

func reasoningFor(c Configuration) *reasoningRequest {
	// Never send provider-specific parameters to an arbitrary compatible API.
	if !openRouterEndpoint(c.URL) || !c.ThinkingControllable || c.Thinking == nil {
		return nil
	}
	return &reasoningRequest{Enabled: *c.Thinking}
}

// DiscoverThinking reads provider metadata, not a billable completion. Generic
// compatible APIs have no standard capability schema; unknown means no control.
// Dynamic routers may choose a different model on every request and are unknown.
func (p *Provider) DiscoverThinking(ctx context.Context, c Configuration, refresh bool) bool {
	return p.discoverCapabilities(ctx, c, refresh).Controllable
}

func (p *Provider) WithCapabilities(ctx context.Context, c Configuration, refresh bool) Configuration {
	capabilities := p.discoverCapabilities(ctx, c, refresh)
	c.ThinkingControllable = capabilities.Controllable
	c.StructuredOutput = capabilities.Structured || c.OutputProfile == "json_schema"
	c.ThinkingEffort = capabilities.ollamaEffort
	c.Ollama = capabilities.ollama
	return c
}

func (p *Provider) discoverCapabilities(ctx context.Context, c Configuration, refresh bool) Capabilities {
	if openRouterEndpoint(c.URL) && (c.Model == "openrouter/free" || c.Model == "openrouter/auto") {
		return Capabilities{}
	}
	key := sha256.Sum256([]byte(c.URL + "\x00" + c.Model + "\x00" + c.Key))
	p.contextMu.Lock()
	cached, ok := p.reasoning[key]
	p.contextMu.Unlock()
	if !refresh && ok && time.Now().Before(cached.Expires) {
		return cached.Capabilities
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	capabilities := Capabilities{}
	var req *http.Request
	var err error
	if openRouterEndpoint(c.URL) {
		req, err = http.NewRequestWithContext(lookupCtx, http.MethodGet, strings.TrimRight(c.URL, "/")+"/models", nil)
	} else {
		req, err = ollamaThinkingRequest(lookupCtx, c)
	}
	if err == nil && req != nil {
		if c.Key != "" {
			req.Header.Set("Authorization", "Bearer "+c.Key)
		}
		res, callErr := p.client.Do(req)
		if callErr == nil {
			if res.StatusCode == http.StatusOK {
				if openRouterEndpoint(c.URL) {
					capabilities = advertisedCapabilities(io.LimitReader(res.Body, 8<<20), c.Model)
				} else {
					capabilities = advertisedOllamaThinking(io.LimitReader(res.Body, 2<<20))
				}
			}
			_ = res.Body.Close()
		}
	}
	p.contextMu.Lock()
	defer p.contextMu.Unlock()
	if p.reasoning == nil {
		p.reasoning = make(map[[32]byte]reasoningCapability)
	}
	if len(p.reasoning) >= 64 {
		for k := range p.reasoning {
			delete(p.reasoning, k)
			break
		}
	}
	p.reasoning[key] = reasoningCapability{Capabilities: capabilities, Expires: time.Now().Add(15 * time.Minute)}
	return capabilities
}

// Decode one catalog entry at a time to avoid retaining the whole model catalog.
// A missing mandatory flag is unknown, not evidence that thinking can be off.
func advertisedThinking(reader io.Reader, model string) bool {
	return advertisedCapabilities(reader, model).Controllable
}

func advertisedCapabilities(reader io.Reader, model string) Capabilities {
	if model == "openrouter/free" || model == "openrouter/auto" {
		return Capabilities{}
	}
	dec := json.NewDecoder(reader)
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return Capabilities{}
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return Capabilities{}
		}
		if key != "data" {
			var ignored json.RawMessage
			if dec.Decode(&ignored) != nil {
				return Capabilities{}
			}
			continue
		}
		token, err = dec.Token()
		if err != nil || token != json.Delim('[') {
			return Capabilities{}
		}
		for dec.More() {
			var entry struct {
				ID         string   `json:"id"`
				Parameters []string `json:"supported_parameters"`
				Reasoning  *struct {
					Mandatory *bool `json:"mandatory"`
				} `json:"reasoning"`
			}
			if dec.Decode(&entry) != nil {
				return Capabilities{}
			}
			if entry.ID != model {
				continue
			}
			var capabilities Capabilities
			reasoning, schema, format := false, false, false
			for _, parameter := range entry.Parameters {
				switch parameter {
				case "reasoning":
					reasoning = true
				case "structured_outputs":
					schema = true
				case "response_format":
					format = true
				}
			}
			capabilities.Controllable = reasoning && entry.Reasoning != nil && entry.Reasoning.Mandatory != nil && !*entry.Reasoning.Mandatory
			capabilities.Structured = schema && format
			return capabilities
		}
		return Capabilities{}
	}
	return Capabilities{}
}
