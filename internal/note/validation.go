package note

import (
	"regexp"
	"strings"
)

const MaxTitleBytes = 512
const MaxTagsBytes = 4 << 10

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func ValidID(id string) bool { return idPattern.MatchString(id) }

func NormalizeTags(raw string) string {
	parts := strings.Split(raw, ",")
	tags := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		tag := strings.TrimSpace(part)
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	return strings.Join(tags, ",")
}
