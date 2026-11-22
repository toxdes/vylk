package ai

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark/v2/ast"
	"github.com/yuin/goldmark/v2/extension"
	"github.com/yuin/goldmark/v2/parser"
	"github.com/yuin/goldmark/v2/util"
)

const MaxChunks = 64
const sectionTokens = 2000

// Edit sections are sized for parallel calls: each carries ~1.4K tokens of
// fixed prompt overhead, so the floor keeps overhead small, and the ceiling
// bounds how much text one reply must cover.
const minSectionTokens = 4096
const maxSectionTokens = 12288
const maxSectionBytes = 48 << 10
const maxPlanLines = 32768

// Ranges partition the frozen source, including all whitespace. Neighbours are
// context only; their bytes are never included in the section's editable range.
type Section struct{ Start, End int }
type Plan struct {
	nativeSchema          bool
	Whole                 bool `json:"whole_context"`
	neighbourBytes        int
	thinking              *bool
	ID                    string `json:"id"`
	Version               int    `json:"version"`
	parallel              int
	Sections              int `json:"sections"`
	EstimatedTokens       int `json:"estimated_input_tokens"`
	source, prompt, scope string
	blocks                [][]Block
	ranges                []Section
	history               []Message
	review                []Hunk
	references            []Reference
	// Routed plans start with a body-less routing request; wholeBlocks is set
	// when the entire shared text also fits one request.
	routed      bool
	wholeBlocks []Block
}

func planSections(source string, budget int) ([]Section, error) {
	if source == "" {
		return []Section{{0, 0}}, nil
	}
	// Avoid constructing an AST for pathological newline-heavy input. This is an
	// explicit planning limit, not truncation; no provider requests have run yet.
	if strings.Count(source, "\n") > maxPlanLines {
		return nil, errors.New("note has too many lines to plan safely; share a smaller selection")
	}
	estimate := estimatedInputTokens([]Message{{Content: source}})
	if estimate > budget*MaxChunks {
		return nil, errors.New("shared text is too large to process safely; share a smaller selection")
	}
	if estimate <= budget && len(source) <= maxSectionBytes {
		return []Section{{0, len(source)}}, nil
	}
	// Long lines and extreme container nesting cannot produce a safe bounded
	// editable block. Reject before building the parser's AST.
	for line := range strings.SplitSeq(source, "\n") {
		if len(line) > maxSectionBytes {
			return nil, errors.New("a Markdown line is too large to process safely; share a smaller selection")
		}
		quotes := 0
		for _, r := range line {
			if r == '>' {
				quotes++
				if quotes > 64 {
					return nil, errors.New("markdown nesting is too deep; share a smaller selection")
				}
			} else if r != ' ' && r != '\t' {
				break
			}
		}
	}
	root := blockParser().ParseStringSource(source)
	starts := []int{0}
	nodes := []ast.Node{}
	for node := root.FirstChild(); node != nil; node = node.NextSibling() {
		if node.Kind() == ast.KindList {
			for item := node.FirstChild(); item != nil; item = item.NextSibling() {
				nodes = append(nodes, item)
			}
		} else {
			nodes = append(nodes, node)
		}
	}
	for _, node := range nodes {
		pos := node.Pos()
		if pos < 0 || pos > len(source) {
			return nil, errors.New("could not locate Markdown blocks safely; share a smaller selection")
		}
		// A node may start after indentation. Include the entire source line.
		pos = strings.LastIndexByte(source[:pos], '\n') + 1
		if pos > starts[len(starts)-1] {
			starts = append(starts, pos)
		}
	}
	starts = append(starts, len(source))
	ranges := make([]Section, 0, min(MaxChunks, len(starts)))
	begin, end := 0, 0
	for i := 0; i+1 < len(starts); i++ {
		next := starts[i+1]
		block := source[starts[i]:next]
		if len(block) > maxSectionBytes || estimatedInputTokens([]Message{{Content: block}}) > budget {
			return nil, errors.New("a passage is too large to process safely; share a smaller selection")
		}
		if end > begin && (len(source[begin:next]) > maxSectionBytes || estimatedInputTokens([]Message{{Content: source[begin:next]}}) > budget) {
			ranges = append(ranges, Section{begin, end})
			begin = end
		}
		end = next
	}
	if end > begin {
		ranges = append(ranges, Section{begin, end})
	}
	if len(ranges) > MaxChunks {
		return nil, errors.New("shared text is too large to process safely; share a smaller selection")
	}
	return ranges, nil
}

func neighbour(source string, start, end int) string {
	for start < end && !utf8.RuneStart(source[start]) {
		start++
	}
	for end > start && end < len(source) && !utf8.RuneStart(source[end]) {
		end--
	}
	return source[start:end]
}

func (p *Plan) messages(index int) []Message { return p.request(index, "", nil, nil) }

// Tools are offered only to plans that read the shared text without
// references; revisions and scope "none" keep the plain contract.
func (p *Plan) toolsEnabled() bool { return p.scope != "none" && len(p.references) == 0 }

func (p *Plan) request(index int, mode string, tools *turnTools, names []string) []Message {
	r := p.ranges[index]
	system := SystemPrompt
	if len(p.references) > 0 {
		system += ReferencePrompt
	}
	if names != nil {
		system += ToolPrompt
	}
	if mode == "collect_findings" {
		system += FindingsPrompt
	}
	review := []Hunk{}
	for _, h := range p.review {
		if h.Start <= r.End && h.End >= r.Start {
			review = append(review, h)
		}
	}
	input := providerInput(p.scope, p.blocks[index], p.prompt, review, referencesForRange(p.references, p.source, r))
	if mode != "" {
		input.Mode = mode
	}
	if names != nil {
		input.offerTools(tools, names)
	}
	if !(len(p.ranges) == 1 && r.Start == 0 && r.End == len(p.source)) {
		input.Index, input.Total = index+1, len(p.ranges)
		if input.Mode != "revise_suggestions" {
			before := neighbour(p.source, max(0, r.Start-p.neighbourBytes), r.Start)
			after := neighbour(p.source, r.End, min(len(p.source), r.End+p.neighbourBytes))
			input.Before, input.After = &before, &after
		}
		system += SectionPrompt
	}
	return p.conversation(system, input)
}

func (p *Plan) conversation(system string, input providerContext) []Message {
	data, _ := json.Marshal(input)
	messages := []Message{{"system", system}}
	messages = append(messages, p.history...)
	return append(messages, Message{"user", string(data)})
}

func (p *Plan) initialCalls() int {
	if p.routed {
		return 1
	}
	return len(p.ranges)
}

func (p *Plan) routeTools() []string {
	names := append([]string{routeEditSections, routeCombine}, textTools...)
	if p.wholeBlocks != nil {
		names = append(names, routeReadWhole)
	}
	return names
}

func (p *Plan) routeMessages(tools *turnTools) []Message {
	input := providerInput(p.scope, []Block{}, p.prompt, []Hunk{}, nil)
	input.SharedText = &sharedText{textStats: sharedStats(p.source), Headings: len(outline(p.source)), Sections: len(p.ranges), FitsOneRequest: p.wholeBlocks != nil}
	input.offerTools(tools, p.routeTools())
	return p.conversation(SystemPrompt+ToolPrompt+RoutePrompt, input)
}

func (p *Plan) wholeMessages(tools *turnTools) []Message {
	input := providerInput(p.scope, p.wholeBlocks, p.prompt, p.review, nil)
	input.offerTools(tools, textTools)
	return p.conversation(SystemPrompt+ToolPrompt, input)
}

func (p *Plan) combineMessages(findings []finding, tools *turnTools, merge bool) []Message {
	input := providerInput(p.scope, []Block{}, p.prompt, []Hunk{}, nil)
	input.Findings = findings
	system := SystemPrompt + MergeFindingsPrompt
	if !merge {
		input.offerTools(tools, textTools)
		system = SystemPrompt + ToolPrompt + CombinePrompt
	}
	return p.conversation(system, input)
}

const SectionPrompt = `
This is part of a frozen note, not a complete global view. Do not claim to summarize, compare or reorganize the whole note from local text. If the request needs the whole text together, return changes=[] and ask the user to share a smaller selection that fits in one request. Edit only supplied block IDs; read_only_before/after are neighbours for understanding, never editable. Section numbers are processing IDs, not heading numbers. Check all blocks, return only requested corrections, preserve internal Markdown/whitespace, and never copy text between blocks. Use the same conversational reply style without mentioning sections or processing.`

// Block positions do not require inline emphasis/link parsing. This avoids
// thousands of needless inline nodes for large notes; GFM tables remain atomic.
func blockParser() parser.Parser {
	return parser.New(parser.WithDefaultParsers(false), parser.WithExtensions(extension.NewTableParser()), parser.WithBlockParsers(
		util.Prioritized(parser.NewSetextHeadingParser(), 100),
		util.Prioritized(parser.NewThematicBreakParser(), 200),
		util.Prioritized(parser.NewListParser(), 300),
		util.Prioritized(parser.NewListItemParser(), 400),
		util.Prioritized(parser.NewCodeBlockParser(), 500),
		util.Prioritized(parser.NewATXHeadingParser(), 600),
		util.Prioritized(parser.NewFencedCodeBlockParser(), 700),
		util.Prioritized(parser.NewBlockquoteParser(), 800),
		util.Prioritized(parser.NewHTMLBlockParser(), 900),
		util.Prioritized(parser.NewParagraphParser(), 1000),
	), parser.WithParagraphTransformers(util.Prioritized(parser.LinkReferenceParagraphTransformer, 100)))
}
