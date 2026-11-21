package ai

import (
	"strings"
	"testing"
)

func TestProviderErrorsAreActionableWithoutReflectingUpstreamText(t *testing.T) {
	for _, tc := range []struct {
		status     int
		data, want string
	}{
		{400, `{"error":{"code":"context_length_exceeded","message":"private note and secret key"}}`, "context window"},
		{401, `{"error":{"message":"private note and secret key"}}`, "API key"},
		{402, `{"error":{"message":"private note and secret key"}}`, "credits"},
		{429, `{"error":{"message":"private note and secret key"}}`, "quota"},
		{503, `{"error":{"message":"private note and secret key"}}`, "unavailable"},
		{502, `{"error":{"code":429,"message":"private note and secret key"}}`, "quota"},
	} {
		err := providerFailure(tc.status, []byte(tc.data))
		if !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "private note") || strings.Contains(err.Error(), "secret key") {
			t.Fatal("unhelpful or unsafe error", err)
		}
	}
}
