package ai

import (
	"encoding/json"
	"errors"
)

// Reserve room for whole-block rewrites (both anchors and replacements), IDs and
// JSON escaping. This is an estimate with expansion headroom, not a tokenizer or
// a generation cap; arbitrary expansion requests and thinking can still exceed it.
func estimatedReplyTokens(blocks []Block) int {
	tokens, _ := estimatedReplyBudget(blocks)
	return tokens
}

func estimatedReplyBudget(blocks []Block) (int, int) {
	changes := make([]BlockChange, len(blocks))
	for i, block := range blocks {
		changes[i] = BlockChange{ID: block.ID, Before: block.Text, After: block.Text}
	}
	data, _ := json.Marshal(struct {
		Answer  string        `json:"answer"`
		Changes []BlockChange `json:"changes"`
	}{ReviewChangesAnswer, changes})
	estimate := estimatedInputTokens([]Message{{Content: string(data)}})
	return estimate + estimate/4 + 128, len(data)
}

func (p *Plan) prepareSections(capacity modelContext) error {
	budget := sectionTokens
	known := capacity.Tokens > 0 || capacity.OutputTokens > 0
	reserve := outputReserve(capacity)
	if capacity.Tokens > 0 {
		// Small notes go in one request. Larger ones split into about one section
		// per parallel call, since wall time is ceil(sections/parallel) calls.
		// The parser caps section bytes and the checks below decide fit.
		total := estimatedInputTokens([]Message{{Content: p.source}})
		target := total
		if total > minSectionTokens {
			parallel := max(1, p.parallel)
			target = min(max((total+parallel-1)/parallel, minSectionTokens), maxSectionTokens)
		}
		if len(p.references) > 0 {
			// Revisions dispatch only sections holding their suggestions; small
			// sections keep unrelated note text out of those requests.
			target = min(target, sectionTokens)
		} else if total > minSectionTokens {
			target = balancedTarget(p.source, total, target, max(1, p.parallel), capacity.Tokens)
		}
		budget = max(64, min(target, capacity.Tokens))
	}
	if capacity.OutputTokens > 0 {
		budget = min(budget, max(64, capacity.OutputTokens))
	}

	if capacity.Tokens > 0 {
		p.neighbourBytes = min(p.neighbourBytes, capacity.Tokens/8)
	}
	for {
		ranges, err := planSections(p.source, budget)
		if err != nil {
			return err
		}
		if p.Whole && len(p.references) == 0 {
			if capacity.Tokens == 0 && len(ranges) > 1 {
				return errors.New("reading this much text in one request needs a known context window; select less text or test a model that reports its capacity")
			}
			ranges = []Section{{0, len(p.source)}}
		}
		p.ranges = referencedSections(p.references, p.source, ranges)
		p.Sections = len(p.ranges)
		p.blocks = make([][]Block, len(p.ranges))
		for i, r := range p.ranges {
			p.blocks[i], err = editableBlocks(p.source[r.Start:r.End], r.Start, p.Version)
			if err != nil {
				return err
			}
		}
		p.EstimatedTokens = 0
		fits := true
		for i := range p.ranges {
			messages := p.messages(i)
			if len(p.ranges) == 1 && p.toolsEnabled() {
				messages = p.request(i, "", newTurnTools(p.source, p.scope), textTools)
			}
			input := estimatedInputTokens(messages)
			if p.nativeSchema {
				input += estimatedSchemaTokens(scopedResponseFormat(messages))
			}
			output := 0
			if known {
				var bytes int
				targets := providerTargets(p.blocks[i], referencesForRange(p.references, p.source, p.ranges[i]))
				output, bytes = estimatedReplyBudget(targets)
				if bytes > MaxContext || len(targets) > MaxBlockChanges {
					fits = false
				}
			}
			if capacity.OutputTokens > 0 && output > capacity.OutputTokens {
				fits = false
			}
			if capacity.Tokens > 0 && input+max(reserve, output) > capacity.Tokens {
				fits = false
			}
			p.EstimatedTokens += input
		}
		if fits {
			p.prepareRouting(capacity)
			return nil
		}
		if p.Whole {
			return errors.New("the shared text and reply cannot fit together in this model; select less text, use a larger context window")
		}
		if budget == 64 {
			return errors.New("the model's available context or output window cannot fit this request safely; shorten the conversation, share a smaller selection, or increase the server's configured limits; no AI request was sent")
		}
		// A bounded sequence (at most nine parses) tightens source ranges without
		// changing the draft or publishing anything. Keep Markdown units atomic.
		budget = max(64, budget/2)
	}
}

// Packing at block boundaries can leave a small remainder section, which costs
// a whole extra round of parallel calls. Grow the target (at most nine parses)
// until the rounds match the ideal split.
func balancedTarget(source string, total, target, parallel, window int) int {
	rounds := func(sections int) int { return (sections + parallel - 1) / parallel }
	ideal := rounds((total + target - 1) / target)
	for target < maxSectionTokens {
		ranges, err := planSections(source, max(64, min(target, window)))
		if err != nil || rounds(len(ranges)) <= ideal {
			break
		}
		target = min(maxSectionTokens, target+target/8)
	}
	return target
}

// Multi-section plans route first, so questions are not answered piecemeal.
// The whole text is offered as one request only when input and reply fit.
func (p *Plan) prepareRouting(capacity modelContext) {
	p.routed = len(p.ranges) > 1 && p.toolsEnabled() && !p.Whole
	p.wholeBlocks = nil
	if !p.routed || capacity.Tokens == 0 {
		return
	}
	route := estimatedInputTokens(p.routeMessages(newTurnTools(p.source, p.scope)))
	if p.nativeSchema {
		route += estimatedSchemaTokens(scopedResponseFormat(p.routeMessages(newTurnTools(p.source, p.scope))))
	}
	p.EstimatedTokens += route
	blocks, err := editableBlocks(p.source, 0, p.Version)
	if err != nil || len(blocks) > MaxBlockChanges {
		return
	}
	p.wholeBlocks = blocks
	// read_whole mainly answers questions, so it reserves a normal reply rather
	// than a full rewrite; large edits route to edit_sections instead.
	if estimatedInputTokens(p.wholeMessages(newTurnTools(p.source, p.scope)))+outputReserve(capacity) > capacity.Tokens {
		p.wholeBlocks = nil
	}
}
