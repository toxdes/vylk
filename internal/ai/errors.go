package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Interpret known error categories without reflecting arbitrary upstream text,
// which may contain credentials, prompts, or untrusted markup.
func providerFailure(status int, data []byte) error {
	var envelope struct {
		Error struct {
			Code    json.RawMessage `json:"code"`
			Message string          `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &envelope) == nil {
		if code, err := strconv.Atoi(strings.Trim(string(envelope.Error.Code), `"`)); err == nil && code >= 400 && code <= 599 {
			status = code
		}
		message := strings.ToLower(envelope.Error.Message + " " + string(envelope.Error.Code))
		for _, hint := range []string{"context_length_exceeded", "maximum context", "context window", "too many tokens"} {
			if strings.Contains(message, hint) {
				return errors.New("shared text and conversation exceed the model's context window; share a smaller selection or start a new conversation")
			}
		}
	}
	switch status {
	case 401, 403:
		return errors.New("provider rejected access; check the API key and model permissions in AI preferences")
	case 402:
		return errors.New("provider requires credits; check the provider account's balance")
	case 429:
		return errors.New("provider rate limit or quota reached; wait before trying again or choose another configuration")
	case 408, 504:
		return errors.New("provider timed out before completing an answer; try a smaller selection or another model")
	case 413:
		return errors.New("provider rejected the request size; share a smaller selection")
	}
	if status >= 500 {
		return errors.New("provider is unavailable or failed to generate an answer; try again manually or choose another model")
	}
	return fmt.Errorf("provider rejected the request (HTTP %d); check the endpoint and model in AI preferences", status)
}
