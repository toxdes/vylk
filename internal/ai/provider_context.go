package ai

// Provider-only projection. Pending revisions expose proposed text once, under
// its @ID, rather than competing note/before/after versions as editable drafts.
type providerContext struct {
	Scope              string      `json:"scope"`
	Mode               string      `json:"mode,omitempty"`
	Blocks             []Block     `json:"blocks"`
	Originals          []Block     `json:"originals_read_only,omitempty"`
	ReadOnlyReferences []Reference `json:"read_only_references,omitempty"`
	Request            string      `json:"request"`
	Review             []Hunk      `json:"previous_review"`
	References         []Reference `json:"references"`
	Before             *string     `json:"read_only_before,omitempty"`
	After              *string     `json:"read_only_after,omitempty"`
	Index              int         `json:"section,omitempty"`
	Total              int         `json:"sections,omitempty"`
	SharedText         *sharedText `json:"shared_text,omitempty"`
	Findings           []finding   `json:"findings,omitempty"`
	ToolsAvailable     []string    `json:"tools_available,omitempty"`
	ToolRoundsLeft     *int        `json:"tool_rounds_remaining,omitempty"`
	MaxToolsPerRound   int         `json:"max_tools_per_round,omitempty"`
}

// Routing describes text it does not include; the model asks tools for more.
type sharedText struct {
	textStats
	Headings       int  `json:"headings"`
	Sections       int  `json:"sections"`
	FitsOneRequest bool `json:"fits_one_request"`
}

type finding struct {
	Part int    `json:"part"`
	Text string `json:"text"`
}

// offerTools advertises tools and the turn's remaining rounds in a request.
func (input *providerContext) offerTools(tools *turnTools, names []string) {
	input.ToolsAvailable = tools.offered(names)
	rounds := 0
	if tools != nil {
		rounds = tools.rounds
	}
	input.ToolRoundsLeft = &rounds
	input.MaxToolsPerRound = maxToolCalls
}

func revisingSuggestions(refs []Reference) bool {
	for _, ref := range refs {
		if ref.Status == "pending" {
			return true
		}
	}
	return false
}

func providerTargets(blocks []Block, refs []Reference) []Block {
	if !revisingSuggestions(refs) {
		if len(refs) > 0 {
			return []Block{}
		}
		return blocks
	}
	targets := []Block{}
	for _, ref := range refs {
		if ref.Status == "pending" && ref.EditableHere {
			targets = append(targets, Block{ID: ref.Ref, Text: ref.After})
		}
	}
	return targets
}

func providerInput(scope string, blocks []Block, prompt string, review []Hunk, refs []Reference) providerContext {
	input := providerContext{Scope: scope, Blocks: blocks, Request: prompt, Review: review, References: refs}
	if !revisingSuggestions(refs) {
		if len(refs) > 0 {
			input.Blocks = []Block{}
		}
		return input
	}
	input.Mode = "revise_suggestions"
	input.Blocks = providerTargets(blocks, refs)
	input.Review = []Hunk{}
	input.References = append([]Reference{}, refs...)
	for i, ref := range refs {
		if ref.Status != "pending" {
			continue
		}
		if ref.EditableHere {
			input.Originals = append(input.Originals, Block{ID: ref.Ref, Text: ref.Before})
		} else {
			input.ReadOnlyReferences = append(input.ReadOnlyReferences, ref)
		}
		input.References[i].Before = ""
		input.References[i].After = ""
	}
	return input
}
