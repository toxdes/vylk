package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// Compatible APIs have no standard discovery protocol. Probe only the sibling
// Ollama metadata endpoint, on the configured origin and proxy path. This sends
// a model name, never note text or a generation request.
func ollamaThinkingRequest(ctx context.Context, c Configuration) (*http.Request, error) {
	u := ollamaMetadataURL(c, "/api/show")
	if u == "" {
		return nil, nil
	}
	body, err := json.Marshal(struct {
		Model string `json:"model"`
	}{c.Model})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(string(body)))
	if err == nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, err
}

type ollamaMetadata struct {
	Capabilities []string `json:"capabilities"`
	Details      struct {
		Family string `json:"family"`
	} `json:"details"`
	Thinking *struct {
		Values  []json.RawMessage `json:"values"`
		Default json.RawMessage   `json:"default"`
	} `json:"thinking"`
	ModelInfo   map[string]json.RawMessage `json:"model_info"`
	Parameters  string                     `json:"parameters"`
	RemoteHost  string                     `json:"remote_host"`
	RemoteModel string                     `json:"remote_model"`
}

func advertisedOllamaThinking(reader io.Reader) Capabilities {
	var metadata ollamaMetadata
	dec := json.NewDecoder(reader)
	if dec.Decode(&metadata) != nil {
		return Capabilities{}
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return Capabilities{}
	}
	capabilities := ollamaThinkingControls(metadata)
	capabilities.ollama = metadata.Details.Family != "" && len(metadata.Capabilities) > 0
	if capabilities.ollama {
		capabilities.Structured = slices.Contains(metadata.Capabilities, "completion") && metadata.RemoteHost == "" && metadata.RemoteModel == ""
		capabilities.capacity = ollamaConfiguredCapacity(metadata)
	}
	return capabilities
}

func ollamaThinkingControls(metadata ollamaMetadata) Capabilities {
	if metadata.Thinking == nil {
		// Imported Qwen3.5 GGUFs in Ollama 0.40.13 advertise only the thinking
		// capability and architecture. That family implements boolean thinking;
		// unlike level-only models (e.g. GPT-OSS), "none" disables it. Use the
		// server-reported family, never a model-name substring or a blanket
		// assumption about every thinking-capable model. Explicit newer metadata
		// above takes precedence, including an advertised mandatory-only control.
		if metadata.Details.Family == "qwen35" && slices.Contains(metadata.Capabilities, "thinking") {
			return Capabilities{Controllable: true, ollamaEffort: "medium"}
		}
		return Capabilities{}
	}
	on, off, named := false, false, ""
	for _, value := range metadata.Thinking.Values {
		switch string(value) {
		case "true":
			on = true
		case "false":
			off = true
		default:
			var level string
			if json.Unmarshal(value, &level) != nil || !ValidText(level, 64) || strings.TrimSpace(level) == "" {
				return Capabilities{}
			}
			if level == "none" {
				off = true
			} else if named == "" || string(value) == string(metadata.Thinking.Default) {
				named = level
			}
		}
	}
	// Ollama maps "none" to false and "medium" to true for boolean controls.
	// Level-only models must explicitly advertise "none" and a non-off level.
	if !off || (!on && named == "") || (on && named != "") {
		return Capabilities{}
	}
	if on {
		named = "medium"
	}
	return Capabilities{Controllable: true, ollamaEffort: named}
}

func ollamaReasoningFor(c Configuration) string {
	if openRouterEndpoint(c.URL) || !c.ThinkingControllable || c.Thinking == nil || c.ThinkingEffort == "" {
		return ""
	}
	if *c.Thinking {
		return c.ThinkingEffort
	}
	return "none"
}

func ollamaMetadataURL(c Configuration, path string) string {
	u, err := url.Parse(c.URL)
	if err != nil || !strings.HasSuffix(strings.TrimRight(u.Path, "/"), "/v1") {
		return ""
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/v1") + path
	u.RawPath = ""
	return u.String()
}
