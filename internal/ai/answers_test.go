package ai

import "testing"

func TestMergeAnswersKeepsOneCoherentEditAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name      string
		parts     []string
		ack, want string
	}{
		{"repeated acknowledgements", []string{ReviewChangesAnswer, ReviewChangesAnswer, NoChangesAnswer}, ReviewChangesAnswer, ReviewChangesAnswer},
		{"real limitation", []string{ReviewChangesAnswer, "I could not resolve the ambiguous abbreviation.", ReviewChangesAnswer}, ReviewChangesAnswer, ReviewChangesAnswer + "\n\nI could not resolve the ambiguous abbreviation."},
		{"questions", []string{"Here are two ideas.", "Here are two ideas."}, "", "Here are two ideas."},
		{"greeting without edits", []string{"Hi! How can I help?"}, "", "Hi! How can I help?"},
		{"no actual changes", []string{ReviewChangesAnswer, NoChangesAnswer}, "", NoChangesAnswer},
		{"withdrawal", []string{ReviewChangesAnswer, NoChangesAnswer}, RevisedSuggestionsAnswer, RevisedSuggestionsAnswer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := mergeAnswers(tc.parts, tc.ack); got != tc.want {
				t.Fatal(got)
			}
		})
	}
}
