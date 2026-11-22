package ai

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReplacementHunksApplyExactlyAndRemainValidUTF8(t *testing.T) {
	for _, tc := range []struct{ name, before, after string }{
		{"repeated paragraphs", "He go.\n\nHe go.\n", "He went.\n\nHe goes.\n"},
		{"insertion", "one\nthree", "one\ntwo\nthree"},
		{"deletion", "one\ntwo\nthree", "one\nthree"},
		{"Unicode", "🙂 Café\nline\n", "😊 Cafè\nline\n"},
		{"CRLF", "# Draft\r\n\r\nHe go.\r\n", "# Draft\r\n\r\nHe went.\r\n"},
		{"empty original", "", "- [ ] Plan trip"},
		{"delete all", "entire note", ""},
		{"same", "unchanged", "unchanged"},
		{"large fallback", strings.Repeat("same\n", 2000) + "end", strings.Repeat("same\n", 2000) + "END"},
		{"newline-heavy fallback", strings.Repeat("\n", MaxContext-1) + "x", strings.Repeat("\n", MaxContext-1) + "y"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hunks, err := replacementHunks(tc.before, tc.after, "note")
			if err != nil {
				t.Fatal(err)
			}
			result := tc.before
			for i := len(hunks) - 1; i >= 0; i-- {
				h := hunks[i]
				if h.Start < 0 || h.End > len(tc.before) || h.Start > h.End || tc.before[h.Start:h.End] != h.Before || !utf8.ValidString(h.Before) || !utf8.ValidString(h.After) {
					t.Fatal("invalid hunk", h)
				}
				result = result[:h.Start] + h.After + result[h.End:]
			}
			if result != tc.after {
				t.Fatalf("lost text: %q != %q", result, tc.after)
			}
		})
	}
	if _, err := replacementHunks("", "insert", "none"); err == nil {
		t.Fatal("unshared replacement accepted")
	}
}

func TestReplacementSupportsPartialReviewRefinementAndUndo(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	s, _ := m.Create("owner", "note", "note", "He go.\n\nShe walk.\n", Configuration{})
	_, _, _, _ = m.Begin(s.ID, "owner", "fix grammar", 0)
	replacement := "He went.\n\nShe walked.\n"
	s, err := m.Finish(s.ID, "owner", `{"answer":"Review","replacement":"He went.\n\nShe walked.\n"}`, Reply{Answer: "Review", Replacement: &replacement}, nil)
	if err != nil || len(s.Hunks) != 2 {
		t.Fatal(s, err)
	}
	s, err = m.Review(s.ID, "owner", "accept", s.Hunks[0].ID, s.Version)
	if err != nil || s.Draft != "He went.\n\nShe walk.\n" {
		t.Fatal(s, err)
	}
	s, err = m.Review(s.ID, "owner", "reject", s.Hunks[1].ID, s.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, messages, _, err := m.Begin(s.ID, "owner", "now make it present tense", s.Version)
	if err != nil || sectionText(messages) != "He went.\n\nShe walk.\n" {
		t.Fatal(messages, err)
	}
	s, _ = m.Finish(s.ID, "owner", "", Reply{}, ErrCancelled)
	s, err = m.Review(s.ID, "owner", "undo", "", s.Version)
	if err != nil || s.Draft != "He go.\n\nShe walk.\n" {
		t.Fatal(s, err)
	}
}

func BenchmarkReplacementGrammarDraft(b *testing.B) {
	before := strings.Repeat("A paragraph that stays unchanged.\n\n", 80) + "He go yesterday.\n"
	after := strings.Repeat("A paragraph that stays unchanged.\n\n", 80) + "He went yesterday.\n"
	for b.Loop() {
		if _, err := replacementHunks(before, after, "note"); err != nil {
			b.Fatal(err)
		}
	}
}

func FuzzReplacementHunks(f *testing.F) {
	f.Add("one\nrepeated\nrepeated\n", "one\nchanged\nrepeated\n")
	f.Add("🙂 Café", "😊 Cafè")
	f.Add("", "hello")
	f.Fuzz(func(t *testing.T, before, after string) {
		if len(before) > 2048 || len(after) > 2048 || !ValidText(before, MaxContext) || !ValidText(after, MaxContext) {
			t.Skip()
		}
		hunks, err := replacementHunks(before, after, "note")
		if err != nil {
			t.Fatal(err)
		}
		result := before
		for i := len(hunks) - 1; i >= 0; i-- {
			h := hunks[i]
			if h.Start < 0 || h.Start > h.End || h.End > len(before) || before[h.Start:h.End] != h.Before || !utf8.ValidString(h.Before) || !utf8.ValidString(h.After) {
				t.Fatal("invalid hunk", h)
			}
			if i > 0 && hunks[i-1].End > h.Start {
				t.Fatal("overlapping hunks")
			}
			result = result[:h.Start] + h.After + result[h.End:]
		}
		if result != after {
			t.Fatalf("changed result: %q != %q", result, after)
		}
	})
}
