package ai

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// A short-lived receipt binds a successful explicit test to its exact credentials.
// It keeps unsaved keys out of SQLite and requires no cache or cleanup timer.
func (m *Manager) TestToken(owner string, c Configuration, usageID string) string {
	expires := strconv.FormatInt(time.Now().Add(10*time.Minute).Unix(), 10)
	return usageID + "." + expires + "." + m.testSignature(owner, c, usageID, expires)
}
func (m *Manager) testSignature(owner string, c Configuration, id, expires string) string {
	data, _ := json.Marshal([]any{owner, c.ID, c.Revision, c.URL, c.Key, c.Model, c.OutputProfile, id, expires})
	mac := hmac.New(sha256.New, m.testKey[:])
	_, _ = mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
func (m *Manager) VerifyTestToken(owner string, c Configuration, token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) == 3 && len(parts[0]) == 32 {
		expires, err := strconv.ParseInt(parts[1], 10, 64)
		if err == nil && expires > time.Now().Unix() && m.Context.Err() == nil && hmac.Equal([]byte(parts[2]), []byte(m.testSignature(owner, c, parts[0], parts[1]))) {
			return parts[0], nil
		}
	}
	return "", errors.New("configuration changed or its test expired; test it again before saving")
}
