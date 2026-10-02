package server

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ccojocar/zxcvbn-go"
	"vylk/internal/store"
	"vylk/internal/web"
)

type runtimeConfig struct {
	AppName                string
	Password               string
	Port                   string
	NotesDir               string
	DatabasePath           string
	TrustProxy             bool
	DisableVaultChanges    bool
	RequireStrongPasswords bool
	OpenBrowser            bool
	ArtificialDelay        time.Duration
}

func validateRuntimeCredentials(config runtimeConfig, vault *store.VaultConfig) error {
	if config.DisableVaultChanges && vault != nil && vault.Mode == store.VaultPreparing {
		return fmt.Errorf("VYLK_DISABLE_VAULT_CHANGES cannot be enabled while a vault migration is in progress")
	}
	if (vault == nil || vault.Mode == store.VaultPreparing) && config.Password == "" {
		return fmt.Errorf("VYLK_PASSWORD environment variable is required until the vault is encrypted")
	}
	if config.RequireStrongPasswords && config.Password != "" && zxcvbn.PasswordStrength(config.Password, nil).Score < 4 {
		return fmt.Errorf("VYLK_PASSWORD must be strong when VYLK_REQUIRE_STRONG_PASSWORDS is enabled")
	}
	return nil
}

func loadRuntimeConfig(args []string, getenv func(string) string, secret func(string) (string, error)) (runtimeConfig, error) {
	// Never silently write plaintext under an obsolete encryption configuration.
	for _, name := range []string{"VYLK_ENCRYPTION_PASSWORD", "VYLK_ENCRYPTION_KEY", "VYLK_ENCRYPTION_PASSWORD_FILE", "VYLK_ENCRYPTION_KEY_FILE", "VYLK_MIGRATE_ENCRYPTION"} {
		if getenv(name) != "" {
			return runtimeConfig{}, fmt.Errorf("%s is no longer supported: server-side encryption was removed; export existing server-encrypted notes with the previous version before upgrading", name)
		}
	}
	appName, err := web.ConfiguredName(getenv(web.NameEnv))
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("app name: %w", err)
	}
	password, err := secret("VYLK_PASSWORD")
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("password: %w", err)
	}
	requireStrongPasswords, err := strconv.ParseBool(valueOrDefault(getenv("VYLK_REQUIRE_STRONG_PASSWORDS"), "false"))
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("VYLK_REQUIRE_STRONG_PASSWORDS must be true, false, 1, or 0: %w", err)
	}
	disableVaultChanges, err := strconv.ParseBool(valueOrDefault(getenv("VYLK_DISABLE_VAULT_CHANGES"), "false"))
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("VYLK_DISABLE_VAULT_CHANGES must be true, false, 1, or 0: %w", err)
	}
	return runtimeConfig{
		AppName:                appName,
		Password:               password,
		Port:                   valueOrDefault(getenv("PORT"), "8080"),
		NotesDir:               valueOrDefault(getenv("VYLK_DIR"), "./notes"),
		DatabasePath:           valueOrDefault(getenv("VYLK_DB"), "./vylk.db"),
		TrustProxy:             getenv("VYLK_TRUST_PROXY") == "1",
		DisableVaultChanges:    disableVaultChanges,
		RequireStrongPasswords: requireStrongPasswords,
		OpenBrowser:            shouldOpenBrowser(args, getenv),
		ArtificialDelay:        parseArtificialRTTDelay(getenv(artificialRTTDelayEnv)),
	}, nil
}

func valueOrDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// readSecret supports Docker/Kubernetes-style *_FILE secrets without putting a
// reusable login secret in the process environment. A final line
// break is removed because secret mounts conventionally include one.
func readSecret(name string) (string, error) {
	if path := os.Getenv(name + "_FILE"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r"), nil
	}
	return os.Getenv(name), nil
}
