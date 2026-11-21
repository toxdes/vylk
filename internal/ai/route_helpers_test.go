package ai

import "encoding/json"

// routeToSections answers a routing request with edit_sections, so fakes that
// stand in for a provider keep exercising section behaviour.
func routeToSections(messages []Message) (Reply, bool) {
	var input struct {
		SharedText json.RawMessage `json:"shared_text"`
	}
	if json.Unmarshal([]byte(messages[len(messages)-1].Content), &input) == nil && input.SharedText != nil {
		return Reply{Tools: []ToolCall{{Name: routeEditSections}}}, true
	}
	return Reply{}, false
}
