package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Read-only tools run only on the frozen shared text of a turn. Offsets are
// byte offsets into that text, never into unshared note content.
const (
	MaxToolRounds        = 8
	maxToolCalls         = 8
	maxToolResultBytes   = 32 << 10
	maxToolReadBytes     = 16 << 10
	maxToolMatches       = 20
	maxToolPatternBytes  = 1 << 10
	maxToolHeadings      = 200
	toolExcerptBytes     = 80
	routeEditSections    = "edit_sections"
	routeReadWhole       = "read_whole"
	routeCombine         = "combine"
	toolSearch           = "search"
	toolRead             = "read"
	toolOutline          = "outline"
	toolStats            = "stats"
	toolContextFullError = "context window is full; answer with the results you have"
)

var textTools = []string{toolSearch, toolRead, toolOutline, toolStats}

type ToolCall struct {
	Name       string `json:"name"`
	Pattern    string `json:"pattern"`
	IgnoreCase bool   `json:"ignore_case"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
}

type toolMatch struct {
	Start   int    `json:"start"`
	End     int    `json:"end"`
	Line    int    `json:"line"`
	Excerpt string `json:"excerpt"`
}

type toolHeading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	Start int    `json:"start"`
	Line  int    `json:"line"`
}

type textStats struct {
	Bytes      int `json:"bytes"`
	Characters int `json:"characters"`
	Words      int `json:"words"`
	Lines      int `json:"lines"`
	Paragraphs int `json:"paragraphs"`
}

type toolResult struct {
	Call      ToolCall      `json:"call"`
	Error     string        `json:"error,omitempty"`
	Count     *int          `json:"count,omitempty"`
	Matches   []toolMatch   `json:"matches,omitempty"`
	Start     *int          `json:"start,omitempty"`
	End       *int          `json:"end,omitempty"`
	Text      *string       `json:"text,omitempty"`
	Truncated bool          `json:"truncated,omitempty"`
	Headings  []toolHeading `json:"headings,omitempty"`
	Stats     *textStats    `json:"stats,omitempty"`
}

// toolEnvelope carries results back as the next user message. Block IDs stay
// in the turn's first request; scopedResponseFormat reads them from there.
type toolEnvelope struct {
	Scope          string       `json:"scope"`
	Results        []toolResult `json:"tool_results"`
	Available      []string     `json:"tools_available"`
	RoundsLeft     int          `json:"tool_rounds_remaining"`
	MaxCallsPerTry int          `json:"max_tools_per_round"`
}

// turnTools is one turn's shared tool budget across routing and answering.
type turnTools struct {
	source, scope string
	rounds        int
}

func newTurnTools(source, scope string) *turnTools {
	return &turnTools{source: source, scope: scope, rounds: MaxToolRounds}
}

// offered returns the tools a request may use. Routes spend no round, so they
// stay available after the text tools run out.
func (t *turnTools) offered(names []string) []string {
	offered := []string{}
	for _, name := range names {
		if isRoute(name) || (t != nil && t.rounds > 0) {
			offered = append(offered, name)
		}
	}
	return offered
}

func validateToolCalls(calls []ToolCall, offered []string, changes int) error {
	if len(calls) == 0 {
		return nil
	}
	if changes > 0 {
		return errors.New("request tools or return changes, not both")
	}
	if len(calls) > maxToolCalls {
		return fmt.Errorf("at most %d tools per round", maxToolCalls)
	}
	allowed := make(map[string]bool, len(offered))
	for _, name := range offered {
		allowed[name] = true
	}
	for _, call := range calls {
		if !allowed[call.Name] {
			return fmt.Errorf("tool %q is not available; use only tools_available", call.Name)
		}
		if isRoute(call.Name) && len(calls) != 1 {
			return fmt.Errorf("%s must be the only tool requested", call.Name)
		}
	}
	return nil
}

func isRoute(name string) bool {
	return name == routeEditSections || name == routeReadWhole || name == routeCombine
}

// run executes one round within budget bytes, spending one round.
func (t *turnTools) run(calls []ToolCall, budget int) []toolResult {
	t.rounds--
	budget = min(budget, maxToolResultBytes)
	results := make([]toolResult, 0, len(calls))
	for _, call := range calls {
		result := runTool(t.source, call)
		data, _ := json.Marshal(result)
		if len(data) > budget {
			result = toolResult{Call: call, Error: toolContextFullError}
			data, _ = json.Marshal(result)
		}
		budget -= len(data)
		results = append(results, result)
	}
	return results
}

func runTool(source string, call ToolCall) toolResult {
	switch call.Name {
	case toolSearch:
		return searchTool(source, call)
	case toolRead:
		return readTool(source, call)
	case toolOutline:
		return toolResult{Call: call, Headings: outline(source)}
	case toolStats:
		stats := sharedStats(source)
		return toolResult{Call: call, Stats: &stats}
	}
	return toolResult{Call: call, Error: "unknown tool"}
}

// RE2 matching is linear in the text, so a hostile pattern cannot stall a turn.
func searchTool(source string, call ToolCall) toolResult {
	result := toolResult{Call: call}
	if call.Pattern == "" || len(call.Pattern) > maxToolPatternBytes {
		result.Error = "pattern must be 1 to 1024 bytes"
		return result
	}
	pattern := call.Pattern
	if call.IgnoreCase {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		result.Error = "invalid RE2 pattern: " + err.Error()
		return result
	}
	count, line, lineAt := 0, 1, 0
	matches := []toolMatch{}
	for pos := 0; pos <= len(source); {
		loc := re.FindStringIndex(source[pos:])
		if loc == nil {
			break
		}
		start, end := pos+loc[0], pos+loc[1]
		count++
		if len(matches) < maxToolMatches {
			line += strings.Count(source[lineAt:start], "\n")
			lineAt = start
			matches = append(matches, toolMatch{Start: start, End: end, Line: line, Excerpt: excerpt(source, start, end)})
		}
		if end > start {
			pos = end
		} else if start < len(source) {
			_, size := utf8.DecodeRuneInString(source[start:])
			pos = start + size
		} else {
			break
		}
	}
	result.Count, result.Matches = &count, matches
	return result
}

func excerpt(source string, start, end int) string {
	from, to := runeFloor(source, max(0, start-toolExcerptBytes/2)), runeFloor(source, min(len(source), max(end, start+toolExcerptBytes/2)))
	return source[from:to]
}

func runeFloor(source string, i int) int {
	for i > 0 && i < len(source) && !utf8.RuneStart(source[i]) {
		i--
	}
	return i
}

func readTool(source string, call ToolCall) toolResult {
	result := toolResult{Call: call}
	if call.Start < 0 || call.End < call.Start || call.Start > len(source) {
		result.Error = fmt.Sprintf("start and end must satisfy 0 <= start <= end; the shared text has %d bytes", len(source))
		return result
	}
	start := runeFloor(source, call.Start)
	end := runeFloor(source, min(call.End, len(source), start+maxToolReadBytes))
	text := source[start:end]
	result.Start, result.End, result.Text = &start, &end, &text
	result.Truncated = end < min(call.End, len(source))
	return result
}

// ATX headings outside fenced code; setext headings are not listed.
func outline(source string) []toolHeading {
	headings := []toolHeading{}
	fence, offset := "", 0
	for number, line := range strings.SplitAfter(source, "\n") {
		start := offset
		offset += len(line)
		trimmed := strings.TrimLeft(line, " ")
		if len(line)-len(trimmed) > 3 {
			continue
		}
		if marker := fenceMarker(trimmed); marker != "" {
			if fence == "" {
				fence = marker
			} else if strings.HasPrefix(trimmed, fence) {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		level := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
		rest := trimmed[level:]
		if level < 1 || level > 6 || (rest != "" && rest[0] != ' ' && rest[0] != '\t' && rest[0] != '\n' && rest[0] != '\r') {
			continue
		}
		headings = append(headings, toolHeading{Level: level, Text: strings.TrimSpace(strings.TrimRight(strings.TrimSpace(rest), "#")), Start: start, Line: number + 1})
		if len(headings) == maxToolHeadings {
			break
		}
	}
	return headings
}

func fenceMarker(line string) string {
	for _, marker := range []string{"```", "~~~"} {
		if strings.HasPrefix(line, marker) {
			return marker
		}
	}
	return ""
}

func sharedStats(source string) textStats {
	stats := textStats{Bytes: len(source), Characters: utf8.RuneCountInString(source), Words: len(strings.Fields(source))}
	if source == "" {
		return stats
	}
	stats.Lines = strings.Count(source, "\n") + 1
	if strings.HasSuffix(source, "\n") {
		stats.Lines--
	}
	inParagraph := false
	for line := range strings.SplitSeq(source, "\n") {
		blank := strings.TrimSpace(line) == ""
		if !blank && !inParagraph {
			stats.Paragraphs++
		}
		inParagraph = !blank
	}
	return stats
}

const ToolPrompt = `
Read-only tools: when tools_available is non-empty, the JSON object also has a "tools" array; it is the only extra field allowed. Use tools for exact answers about the shared text instead of guessing: always use search or stats to count characters, words or patterns, never count by reading. Each tool object needs every field: {"name":"search","pattern":"","ignore_case":false,"start":0,"end":0}; unused fields keep those defaults.
- search: pattern is an RE2 regular expression over the whole shared text; returns the exact match count and the first 20 matches with byte offsets, line numbers and excerpts.
- read: returns the text from byte offset start to end, at most 16 KiB per call.
- outline: Markdown headings with byte offsets and line numbers.
- stats: bytes, characters, words, lines and paragraphs.
Request at most max_tools_per_round tools per reply with answer "" and changes=[]. Results arrive in tool_results. tool_rounds_remaining is how many more replies may request tools; plan your calls to fit it. With no rounds left or tools=[] in tools_available, return your final answer with tools=[]. Offsets refer only to the shared text.`

const RoutePrompt = `
The shared text is too large for this request, so blocks is empty; shared_text describes it. Choose how to handle the request with exactly one tools entry, or answer directly:
- edit_sections: propose edits across the whole shared text; each part is edited separately with the same request.
- read_whole: answer or edit from the entire text in one request; only offered when it fits.
- combine: answer a question that needs the whole text when read_whole is not offered; each part reports findings, then you answer from them.
- search, read, outline, stats: answer exactly from the text without reading all of it.
Answer directly with tools=[] when the request needs no shared text.`

const FindingsPrompt = `
mode="collect_findings": do not edit; changes must be []. In answer, report only what these blocks contain that bears on the request (facts, quotes, figures, positions), in at most 300 words. Say "Nothing relevant." when there is nothing.`

const CombinePrompt = `
findings holds notes that separate requests extracted from consecutive parts of the shared text, in order. Answer the request from them as if you had read the whole text, without mentioning parts, findings or processing. changes must be []. Use tools only to verify exact details.`

const MergeFindingsPrompt = `
findings holds notes from consecutive parts of the shared text. Merge them into one note of at most 300 words that keeps every fact, figure and position relevant to the request. changes must be [].`
