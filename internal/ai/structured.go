package ai

import (
	"encoding/json"
	"strconv"
	"strings"
)

type providerRouting struct {
	RequireParameters bool `json:"require_parameters"`
}

// A single response format avoids unions and optional fields across providers.
// Validation of block IDs, ranges and sizes remains the application's job.
const blockResponseFormat = `{"type":"json_schema","json_schema":{"name":"note_changes","strict":true,"schema":{"type":"object","properties":{"answer":{"type":"string"},"changes":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"before":{"type":"string"},"after":{"type":"string"}},"required":["id","before","after"],"additionalProperties":false}}},"required":["answer","changes"],"additionalProperties":false}}}`

func structuredFormat(c Configuration, messages []Message) (json.RawMessage, *providerRouting) {
	if !c.StructuredOutput {
		return nil, nil
	}
	format := scopedResponseFormat(messages)
	if c.Ollama {
		return format, nil
	}
	if !openRouterEndpoint(c.URL) {
		if c.OutputProfile == "json_schema" {
			return format, nil
		}
		return nil, nil
	}
	// Catalog capabilities can aggregate endpoints. Require parameter support so
	// routing cannot silently drop the schema at an incompatible endpoint.
	return format, &providerRouting{RequireParameters: true}
}

type scopedInput struct {
	Mode   string `json:"mode"`
	Scope  string `json:"scope"`
	Blocks *[]struct {
		ID string `json:"id"`
	} `json:"blocks"`
	Tools []string `json:"tools_available"`
}

// Targets are server-built. Restrict native decoding to editable IDs only,
// including correction attempts; prompt-only requests cannot return changes.
// Tool-result messages carry no blocks: IDs come from the turn's latest user
// message that has them, while offered tools come from the last message.
func scopedResponseFormat(messages []Message) json.RawMessage {
	if len(messages) == 0 || messages[len(messages)-1].Role != "user" {
		return json.RawMessage(blockResponseFormat)
	}
	var last scopedInput
	if json.Unmarshal([]byte(messages[len(messages)-1].Content), &last) != nil || last.Scope == "" {
		return json.RawMessage(blockResponseFormat)
	}
	input := last
	for i := len(messages) - 1; input.Blocks == nil && i >= 0; i-- {
		if messages[i].Role == "user" && json.Unmarshal([]byte(messages[i].Content), &input) != nil {
			break
		}
	}
	ids := []string{}
	if input.Scope != "none" && input.Mode != "collect_findings" && input.Blocks != nil {
		for _, block := range *input.Blocks {
			ids = append(ids, block.ID)
		}
	}
	format := blockResponseFormat
	if len(ids) == 0 {
		format = strings.Replace(format, `"changes":{"type":"array"`, `"changes":{"type":"array","maxItems":0`, 1)
	} else {
		idSchema, _ := json.Marshal(struct {
			Type string   `json:"type"`
			Enum []string `json:"enum"`
		}{"string", ids})
		format = strings.Replace(format, `"id":{"type":"string"}`, `"id":`+string(idSchema), 1)
	}
	if len(last.Tools) > 0 {
		names, _ := json.Marshal(last.Tools)
		tools := `"tools":{"type":"array","maxItems":` + strconv.Itoa(maxToolCalls) + `,"items":{"type":"object","properties":{"name":{"type":"string","enum":` + string(names) + `},"pattern":{"type":"string"},"ignore_case":{"type":"boolean"},"start":{"type":"integer"},"end":{"type":"integer"}},"required":["name","pattern","ignore_case","start","end"],"additionalProperties":false}}`
		format = strings.Replace(format, `}}},"required":["answer","changes"]`, `}},`+tools+`},"required":["answer","changes","tools"]`, 1)
	}
	return json.RawMessage(format)
}

// Native decoding schemas occupy provider context too, particularly ID enums.
func estimatedSchemaTokens(format json.RawMessage) int {
	return estimatedInputTokens([]Message{{Content: string(format)}})
}
