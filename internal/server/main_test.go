package server

import (
	"testing"
	"time"

	"vylk/internal/store"
)

func TestLoadRuntimeConfigAppliesDefaults(t *testing.T) {
	values := map[string]string{"VYLK_PASSWORD": "secret"}
	getenv := func(key string) string { return values[key] }
	config, err := loadRuntimeConfig(nil, getenv, func(name string) (string, error) {
		return getenv(name), nil
	})
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}
	if config.AppName != "VYLK" || config.Port != "8080" || config.NotesDir != "./notes" || config.DatabasePath != "./vylk.db" {
		t.Fatalf("default runtime config = %#v", config)
	}
	if !config.OpenBrowser {
		t.Fatal("default runtime config disabled browser launch")
	}
}

func TestLoadRuntimeConfigReadsOperationalSettings(t *testing.T) {
	values := map[string]string{
		"VYLK_PASSWORD":           "secret",
		"VYLK_APP_NAME":           "Acme Notes",
		"PORT":                    "9090",
		"VYLK_DIR":                "/notes",
		"VYLK_DB":                 "/data/vylk.db",
		"VYLK_TRUST_PROXY":        "1",
		"VYLK_MIGRATE_ENCRYPTION": "1",
		"ARTIFICIAL_RTT_DELAY_MS": "25",
	}
	getenv := func(key string) string { return values[key] }
	config, err := loadRuntimeConfig([]string{"--no-browser"}, getenv, func(name string) (string, error) {
		return getenv(name), nil
	})
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}
	if config.AppName != "Acme Notes" || config.Port != "9090" || config.NotesDir != "/notes" || config.DatabasePath != "/data/vylk.db" {
		t.Fatalf("runtime config = %#v", config)
	}
	if !config.TrustProxy || !config.MigrateEncryption || config.OpenBrowser || config.ArtificialDelay != 25*time.Millisecond {
		t.Fatalf("runtime flags = %#v", config)
	}
}

func TestLoadRuntimeConfigParsesStrongPasswordPolicy(t *testing.T) {
	for value, want := range map[string]bool{"true": true, "1": true, "false": false, "0": false, "": false} {
		t.Run(value, func(t *testing.T) {
			config, err := loadRuntimeConfig(nil, func(key string) string {
				if key == "VYLK_REQUIRE_STRONG_PASSWORDS" {
					return value
				}
				return ""
			}, func(string) (string, error) { return "", nil })
			if err != nil {
				t.Fatalf("loadRuntimeConfig: %v", err)
			}
			if config.RequireStrongPasswords != want {
				t.Fatalf("RequireStrongPasswords = %t, want %t", config.RequireStrongPasswords, want)
			}
		})
	}
	if _, err := loadRuntimeConfig(nil, func(key string) string {
		if key == "VYLK_REQUIRE_STRONG_PASSWORDS" {
			return "yes"
		}
		return ""
	}, func(string) (string, error) { return "", nil }); err == nil {
		t.Fatal("accepted an invalid VYLK_REQUIRE_STRONG_PASSWORDS value")
	}
}

func TestLoadRuntimeConfigParsesVaultChangePolicy(t *testing.T) {
	for value, want := range map[string]bool{"true": true, "1": true, "false": false, "0": false, "": false} {
		t.Run(value, func(t *testing.T) {
			config, err := loadRuntimeConfig(nil, func(key string) string {
				if key == "VYLK_DISABLE_VAULT_CHANGES" {
					return value
				}
				return ""
			}, func(string) (string, error) { return "", nil })
			if err != nil {
				t.Fatalf("loadRuntimeConfig: %v", err)
			}
			if config.DisableVaultChanges != want {
				t.Fatalf("DisableVaultChanges = %t, want %t", config.DisableVaultChanges, want)
			}
		})
	}
	if _, err := loadRuntimeConfig(nil, func(key string) string {
		if key == "VYLK_DISABLE_VAULT_CHANGES" {
			return "yes"
		}
		return ""
	}, func(string) (string, error) { return "", nil }); err == nil {
		t.Fatal("accepted an invalid VYLK_DISABLE_VAULT_CHANGES value")
	}
}

func TestDisabledVaultChangesRejectPreparingVault(t *testing.T) {
	config := runtimeConfig{Password: "secret", DisableVaultChanges: true}
	if err := validateRuntimeCredentials(config, &store.VaultConfig{Mode: store.VaultPreparing}); err == nil {
		t.Fatal("accepted disabled vault changes during an unfinished migration")
	}
	if err := validateRuntimeCredentials(config, &store.VaultConfig{Mode: store.VaultReady}); err != nil {
		t.Fatalf("rejected a ready encrypted vault: %v", err)
	}
}

func TestValidateRuntimeCredentialsAppliesStrongPasswordPolicy(t *testing.T) {
	ready := &store.VaultConfig{Mode: store.VaultReady}
	if err := validateRuntimeCredentials(runtimeConfig{
		Password: "password", RequireStrongPasswords: true,
	}, ready); err == nil {
		t.Fatal("accepted a weak VYLK_PASSWORD")
	}
	if err := validateRuntimeCredentials(runtimeConfig{
		Password: "correct horse battery staple!", RequireStrongPasswords: true,
	}, ready); err != nil {
		t.Fatalf("rejected a strong VYLK_PASSWORD: %v", err)
	}
	if err := validateRuntimeCredentials(runtimeConfig{
		Password: "correct horse battery staple!", EncryptionPassword: "password", RequireStrongPasswords: true,
	}, ready); err == nil {
		t.Fatal("accepted a weak VYLK_ENCRYPTION_PASSWORD")
	}
	if err := validateRuntimeCredentials(runtimeConfig{Password: "password"}, ready); err != nil {
		t.Fatalf("default policy rejected a weak VYLK_PASSWORD: %v", err)
	}
}

func TestLoadRuntimeConfigRequiresPassword(t *testing.T) {
	config, err := loadRuntimeConfig(nil, func(string) string { return "" }, func(string) (string, error) { return "", nil })
	if err != nil {
		t.Fatalf("loadRuntimeConfig: %v", err)
	}
	err = validateRuntimeCredentials(config, nil)
	if err == nil {
		t.Fatal("legacy vault accepted an empty password")
	}
	if err := validateRuntimeCredentials(config, &store.VaultConfig{Mode: store.VaultReady}); err != nil {
		t.Fatalf("encrypted vault rejected empty password: %v", err)
	}
}

func TestShouldOpenBrowser(t *testing.T) {
	getenv := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}

	tests := []struct {
		name string
		args []string
		env  map[string]string
		want bool
	}{
		{name: "enabled by default", env: map[string]string{}, want: true},
		{name: "command line disable", args: []string{"--no-browser"}, env: map[string]string{}},
		{name: "environment disable", env: map[string]string{"VYLK_NO_BROWSER": "1"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldOpenBrowser(test.args, getenv(test.env)); got != test.want {
				t.Fatalf("shouldOpenBrowser() = %t, want %t", got, test.want)
			}
		})
	}
}

func TestBrowserCommand(t *testing.T) {
	tests := []struct {
		goos string
		name string
		args []string
	}{
		{goos: "linux", name: "xdg-open", args: []string{"http://127.0.0.1:8080/"}},
		{goos: "darwin", name: "open", args: []string{"http://127.0.0.1:8080/"}},
		{goos: "windows", name: "rundll32", args: []string{"url.dll,FileProtocolHandler", "http://127.0.0.1:8080/"}},
	}

	for _, test := range tests {
		t.Run(test.goos, func(t *testing.T) {
			name, args := browserCommand(test.goos, test.args[len(test.args)-1])
			if name != test.name {
				t.Fatalf("browserCommand() name = %q, want %q", name, test.name)
			}
			if len(args) != len(test.args) {
				t.Fatalf("browserCommand() args = %#v, want %#v", args, test.args)
			}
			for index := range args {
				if args[index] != test.args[index] {
					t.Fatalf("browserCommand() args = %#v, want %#v", args, test.args)
				}
			}
		})
	}
}
