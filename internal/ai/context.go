package ai

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type modelContext struct {
	Tokens        int
	OutputTokens  int
	MaximumTokens int
	Expires       time.Time
}

func openRouterEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	return err == nil && u.Scheme == "https" && u.Host == "openrouter.ai" && strings.TrimRight(u.Path, "/") == "/api/v1"
}

// RefreshCapacity runs at Test/Check without a completion or note content. It
// returns the provider-reported window, or zero when the provider states none.
func (p *Provider) RefreshCapacity(ctx context.Context, c Configuration) int {
	return p.modelCapacity(ctx, c, true).Tokens
}

// The configured window wins over discovery: users set it when a provider
// misreports or omits its window. Planning never runs with an unknown window.
func (p *Provider) planningCapacity(ctx context.Context, c Configuration) modelContext {
	capacity := p.modelCapacity(ctx, c, false)
	if c.ContextTokens > 0 {
		capacity.Tokens = c.ContextTokens
	} else if capacity.Tokens == 0 {
		capacity.Tokens = DefaultContextTokens
	}
	return capacity
}

// Context metadata is advisory: compatible servers need not publish a token
// window. Cache both known and unknown results, bound memory, and never send
// note content to the metadata endpoint. No provider SDK or tokenizer is loaded.
func (p *Provider) modelCapacity(ctx context.Context, c Configuration, refresh bool) modelContext {
	key := sha256.Sum256([]byte(c.URL + "\x00" + c.Model + "\x00" + c.Key))
	p.contextMu.Lock()
	if entry, ok := p.contexts[key]; !refresh && ok && time.Now().Before(entry.Expires) {
		p.contextMu.Unlock()
		return entry
	}
	p.contextMu.Unlock()
	endpoint := strings.TrimRight(c.URL, "/") + "/models"
	if openRouterEndpoint(c.URL) {
		parts := strings.Split(c.Model, "/")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
			return modelContext{}
		}
		for i := range parts {
			parts[i] = url.PathEscape(parts[i])
		}
		endpoint += "/" + strings.Join(parts, "/") + "/endpoints"
	}
	metadataCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	capacity := modelContext{}
	req, err := http.NewRequestWithContext(metadataCtx, http.MethodGet, endpoint, nil)
	if err == nil {
		if c.Key != "" {
			req.Header.Set("Authorization", "Bearer "+c.Key)
		}
		res, callErr := p.client.Do(req)
		if callErr == nil {
			if res.StatusCode == http.StatusOK {
				data, readErr := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
				if readErr == nil && len(data) <= 2<<20 {
					capacity = advertisedCapacity(data, c.Model)
				}
			}
			_ = res.Body.Close()
		}
	}
	if !openRouterEndpoint(c.URL) && ollamaMetadataURL(c, "/api/show") != "" {
		capacity = p.ollamaCapacity(metadataCtx, c, capacity)
	}
	p.contextMu.Lock()
	if p.contexts == nil {
		p.contexts = make(map[[32]byte]modelContext)
	}
	if len(p.contexts) >= 64 {
		for oldest := range p.contexts {
			delete(p.contexts, oldest)
			break
		}
	}
	capacity.Expires = time.Now().Add(15 * time.Minute)
	p.contexts[key] = capacity
	p.contextMu.Unlock()
	return capacity
}

func advertisedContext(data []byte, model string) int {
	return advertisedCapacity(data, model).Tokens
}

func advertisedCapacity(data []byte, model string) modelContext {
	type limits struct {
		Context       int `json:"context_length"`
		MaxModelLen   int `json:"max_model_len"`
		MaxOutput     int `json:"max_output_tokens"`
		MaxCompletion int `json:"max_completion_tokens"`
	}
	type entry struct {
		limits
		ID          string   `json:"id"`
		TopProvider limits   `json:"top_provider"`
		Endpoints   []limits `json:"endpoints"`
	}
	capacityFor := func(item entry) modelContext {
		capacity := modelContext{Tokens: validContext(item.Context, item.MaxModelLen), OutputTokens: validContext(item.MaxOutput, item.MaxCompletion)}
		all := append(item.Endpoints, item.TopProvider)
		for _, endpoint := range all {
			capacity.Tokens = minimumKnown(capacity.Tokens, validContext(endpoint.Context, endpoint.MaxModelLen))
			capacity.OutputTokens = minimumKnown(capacity.OutputTokens, validContext(endpoint.MaxOutput, endpoint.MaxCompletion))
		}
		return capacity
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return modelContext{}
	}
	var single entry
	if json.Unmarshal(envelope.Data, &single) == nil && single.ID == model {
		return capacityFor(single)
	}
	var list []entry
	if json.Unmarshal(envelope.Data, &list) == nil {
		for _, item := range list {
			if item.ID == model {
				return capacityFor(item)
			}
		}
	}
	return modelContext{}
}

func validContext(context, fallback int) int {
	if context == 0 {
		context = fallback
	}
	if context > 0 && context <= 16<<20 {
		return context
	}
	return 0
}

// Estimate rather than claim exact counts across unrelated tokenizers. ASCII
// prose averages several characters per token; non-ASCII bytes are budgeted
// conservatively. The provider remains authoritative when its tokenizer differs.
func estimatedInputTokens(messages []Message) int {
	ascii, other := 0, 0
	for _, message := range messages {
		for i := range len(message.Content) {
			if message.Content[i] < 128 {
				ascii++
			} else {
				other++
			}
		}
	}
	return (ascii+2)/3 + other + 32*len(messages)
}

func (p *Provider) Preflight(ctx context.Context, c Configuration, messages []Message) error {
	capacity := p.planningCapacity(ctx, c)
	window := capacity.Tokens
	if err := ctx.Err(); err != nil {
		return err
	}
	reserve := outputReserve(capacity)
	estimate := estimatedInputTokens(messages)
	if format, _ := structuredFormat(c, messages); len(format) > 0 {
		estimate += estimatedSchemaTokens(format)
	}
	if estimate+reserve > window {
		return fmt.Errorf("shared context is estimated at %d input tokens; the configured context window is %d tokens. Share a smaller selection, start a new conversation, or raise the context window in AI settings if the model supports more; no AI request was sent", estimate, window)
	}
	return nil
}

// The effective context is shared by the complete input and generated output.
// Unknown output limits stay unknown; they never become an API output cap.
func outputReserve(capacity modelContext) int {
	reserve := 8192
	if capacity.Tokens > 0 {
		reserve = min(reserve, capacity.Tokens/4)
	}
	if capacity.OutputTokens > 0 {
		reserve = min(reserve, capacity.OutputTokens)
	}
	return reserve
}
