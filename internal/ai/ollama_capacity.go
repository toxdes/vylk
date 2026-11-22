package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func minimumKnown(a, b int) int {
	if a == 0 {
		return b
	}
	if b == 0 {
		return a
	}
	return min(a, b)
}

func ollamaConfiguredCapacity(metadata ollamaMetadata) modelContext {
	var capacity modelContext
	for line := range strings.SplitSeq(metadata.Parameters, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		n, err := strconv.Atoi(fields[1])
		if err != nil || validContext(n, 0) == 0 {
			continue
		}
		switch fields[0] {
		case "num_ctx":
			capacity.Tokens = minimumKnown(capacity.Tokens, n)
		case "num_predict":
			capacity.OutputTokens = minimumKnown(capacity.OutputTokens, n)
		}
	}
	var architecture string
	if json.Unmarshal(metadata.ModelInfo["general.architecture"], &architecture) == nil {
		var maximum int
		if json.Unmarshal(metadata.ModelInfo[architecture+".context_length"], &maximum) == nil {
			capacity.MaximumTokens = validContext(maximum, 0)
		}
	}
	if capacity.Tokens > 0 {
		capacity.Tokens = minimumKnown(capacity.Tokens, capacity.MaximumTokens)
	}
	return capacity
}

// /api/show's architecture maximum is not the window allocated by the runner.
// Consult /api/ps without loading a model or changing its configuration. A missing
// active/configured window stays unknown, rather than becoming (say) 262K.
func (p *Provider) ollamaCapacity(ctx context.Context, c Configuration, known modelContext) modelContext {
	capabilities := p.discoverCapabilities(ctx, c, false)
	if !capabilities.ollama {
		return known
	}
	known.Tokens = minimumKnown(known.Tokens, capabilities.capacity.Tokens)
	known.OutputTokens = minimumKnown(known.OutputTokens, capabilities.capacity.OutputTokens)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ollamaMetadataURL(c, "/api/ps"), nil)
	if err != nil {
		return known
	}
	if c.Key != "" {
		req.Header.Set("Authorization", "Bearer "+c.Key)
	}
	res, err := p.client.Do(req)
	if err != nil {
		return known
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return known
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return known
	}
	known.Tokens = minimumKnown(known.Tokens, ollamaRunningContext(data, c.Model))
	if known.Tokens > 0 {
		known.Tokens = minimumKnown(known.Tokens, capabilities.capacity.MaximumTokens)
	}
	return known
}

func ollamaRunningContext(data []byte, model string) int {
	var envelope struct {
		Models []struct {
			Model   string `json:"model"`
			Name    string `json:"name"`
			Context int    `json:"context_length"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return 0
	}
	window := 0
	for _, entry := range envelope.Models {
		if entry.Model == model || entry.Name == model {
			window = minimumKnown(window, validContext(entry.Context, 0))
		}
	}
	return window
}
