package ai

import "strings"

const ReviewChangesAnswer = "Suggested changes are ready to review."
const NoChangesAnswer = "No new changes were suggested."
const RevisedSuggestionsAnswer = "Updated the referenced suggestions."

// The model uses shared acknowledgements across sections. Keep substantive
// answers and limitations, but do not mix a local no-change result into a turn
// which actually proposed edits elsewhere.
func mergeAnswers(parts []string, acknowledgement string) string {
	var answer strings.Builder
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == NoChangesAnswer && acknowledgement != "" {
			continue
		}
		if part == ReviewChangesAnswer {
			if acknowledgement == "" {
				continue
			}
			part = acknowledgement
		}
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		if answer.Len() > 0 {
			answer.WriteString("\n\n")
		}
		answer.WriteString(part)
	}
	if answer.Len() == 0 {
		if acknowledgement != "" {
			return acknowledgement
		}
		return NoChangesAnswer
	}
	return answer.String()
}
