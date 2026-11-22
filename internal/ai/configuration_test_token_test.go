package ai

import "testing"

func TestConfigurationReceiptBindsCredentialsAndOwner(t *testing.T) {
	m := NewManager()
	defer m.Stop()
	c := Configuration{ID: "provider", Revision: 3, URL: "https://example.com/v1", Key: "secret", Model: "openrouter/free"}
	token := m.TestToken("owner", c, "01234567890123456789012345678901")
	if _, err := m.VerifyTestToken("owner", c, token); err != nil {
		t.Fatal(err)
	}
	nameOnly := c
	nameOnly.Name = "A different display name"
	if _, err := m.VerifyTestToken("owner", nameOnly, token); err != nil {
		t.Fatal("name changes should not require another test", err)
	}
	for _, change := range []func(*Configuration){func(c *Configuration) { c.URL += "/different" }, func(c *Configuration) { c.Key = "other" }, func(c *Configuration) { c.Model = "other" }, func(c *Configuration) { c.ID = "other" }, func(c *Configuration) { c.Revision++ }, func(c *Configuration) { c.OutputProfile = "json_schema" }} {
		changed := c
		change(&changed)
		if _, err := m.VerifyTestToken("owner", changed, token); err == nil {
			t.Fatal("accepted receipt for different configuration")
		}
	}
	if _, err := m.VerifyTestToken("another device", c, token); err == nil {
		t.Fatal("accepted another session's receipt")
	}
	m.Stop()
	if _, err := m.VerifyTestToken("owner", c, token); err == nil {
		t.Fatal("accepted receipt after disabling AI")
	}
}
