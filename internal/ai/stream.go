package ai

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// SSE repeats envelope metadata for every tiny token delta, sometimes including
// reasoning twice. This is a wire-work bound, separate from retained answer size.
const MaxStreamBytes = 32 << 20

type completionEnvelope struct {
	Choices []completionChoice `json:"choices"`
	Usage   Usage              `json:"usage"`
	Timings json.RawMessage    `json:"timings"`
}

type completionChoice struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
	Finish string `json:"finish_reason"`
}

// Consume the OpenAI SSE wire format without forwarding partial edits. All
// content stays bounded and a terminal event is required before validation.
func readCompletionStream(reader io.Reader, observers ...func([]byte, string)) (completionEnvelope, error) {
	var envelope completionEnvelope
	var content strings.Builder
	var finish string
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), MaxHistory+1)
	var event strings.Builder
	process := func() (bool, error) {
		data := strings.TrimSpace(event.String())
		event.Reset()
		if data == "" {
			return false, nil
		}
		if data == "[DONE]" {
			return true, nil
		}
		var chunk struct {
			Choices []struct {
				Index int `json:"index"`
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				Finish string `json:"finish_reason"`
			} `json:"choices"`
			Usage   *Usage          `json:"usage"`
			Timings json.RawMessage `json:"timings"`
			Error   json.RawMessage `json:"error"`
		}
		payload := []byte(data)
		if json.Unmarshal(payload, &chunk) != nil {
			return false, errors.New("provider returned an invalid streaming event")
		}
		if len(chunk.Timings) > 0 && string(chunk.Timings) != "null" {
			envelope.Timings = chunk.Timings
		}
		if chunk.Usage != nil {
			envelope.Usage = *chunk.Usage
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return false, providerFailure(502, []byte(data))
		}
		if len(chunk.Choices) > 1 {
			return false, errors.New("provider returned multiple streamed completions")
		}
		if len(chunk.Choices) == 1 {
			choice := chunk.Choices[0]
			if choice.Index != 0 {
				return false, errors.New("provider returned an unsupported completion index")
			}
			if finish != "" && choice.Delta.Content != "" {
				return false, errors.New("provider sent content after completing the answer")
			}
			if content.Len()+len(choice.Delta.Content) > MaxContext {
				return false, errors.New("model reply exceeds 256 KiB")
			}
			if len(observers) > 0 && observers[0] != nil {
				observers[0](payload, choice.Delta.Content)
			}
			content.WriteString(choice.Delta.Content)
			if choice.Finish != "" {
				if finish != "" && finish != choice.Finish {
					return false, errors.New("provider returned conflicting completion statuses")
				}
				finish = choice.Finish
			}
		}
		return false, nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			done, err := process()
			if err != nil {
				return envelope, err
			}
			if done {
				choice := completionChoice{Finish: finish}
				choice.Message.Content = content.String()
				envelope.Choices = []completionChoice{choice}
				return envelope, nil
			}
		} else if strings.HasPrefix(line, "data:") {
			if event.Len()+len(line) > MaxHistory {
				return envelope, errors.New("provider streaming event exceeded the size limit")
			}
			event.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			event.WriteByte('\n')
		}
	}
	if err := scanner.Err(); err != nil {
		return envelope, err
	}
	return envelope, errors.New("provider stream ended before its completion marker; no edits were accepted")
}
