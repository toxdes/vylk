package ai

import (
	"encoding/json"
	"math"
)

// Optional OpenAI-compatible extensions from llama.cpp/Ollama. Keep missing
// metrics distinct from zero and never let unusable telemetry reject an answer.
type providerInferenceTimings struct {
	CachedTokens *int64   `json:"cache_n,omitempty"`
	PromptTokens *int64   `json:"prompt_n,omitempty"`
	PromptMS     *float64 `json:"prompt_ms,omitempty"`
	PromptRate   *float64 `json:"prompt_per_second,omitempty"`
	OutputTokens *int64   `json:"predicted_n,omitempty"`
	OutputMS     *float64 `json:"predicted_ms,omitempty"`
	OutputRate   *float64 `json:"predicted_per_second,omitempty"`
}

func inferenceTimings(raw json.RawMessage) *providerInferenceTimings {
	var metrics providerInferenceTimings
	if len(raw) == 0 || json.Unmarshal(raw, &metrics) != nil {
		return nil
	}
	for _, count := range []**int64{&metrics.CachedTokens, &metrics.PromptTokens, &metrics.OutputTokens} {
		if *count != nil && **count < 0 {
			*count = nil
		}
	}
	for _, value := range []**float64{&metrics.PromptMS, &metrics.PromptRate, &metrics.OutputMS, &metrics.OutputRate} {
		if *value != nil && **value < 0 {
			*value = nil
		}
	}
	derive := func(count *int64, milliseconds *float64, rate **float64) {
		if *rate == nil && count != nil && milliseconds != nil && *milliseconds > 0 {
			value := float64(*count) * 1000 / *milliseconds
			if !math.IsInf(value, 0) && !math.IsNaN(value) {
				*rate = &value
			}
		}
	}
	derive(metrics.PromptTokens, metrics.PromptMS, &metrics.PromptRate)
	derive(metrics.OutputTokens, metrics.OutputMS, &metrics.OutputRate)
	if metrics.CachedTokens == nil && metrics.PromptTokens == nil && metrics.PromptMS == nil && metrics.PromptRate == nil && metrics.OutputTokens == nil && metrics.OutputMS == nil && metrics.OutputRate == nil {
		return nil
	}
	return &metrics
}

type debugCallKey struct{}
type debugCall struct {
	TurnID  string
	Attempt int
}
