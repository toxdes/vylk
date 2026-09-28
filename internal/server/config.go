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
	EncryptionPassword     string
	EncryptionKey          string
	MigrateEncryption      bool
	RequireStrongPasswords bool
	OpenBrowser            bool
	ArtificialDelay        time.Duration
}

func validateRuntimeCredentials(config runtimeConfig, vault *store.VaultConfig) error {
	if (vault == nil || vault.Mode == store.VaultPreparing) && config.Password == "" {
		return fmt.Errorf("VYLK_PASSWORD environment variable is required until the vault is encrypted")
	}
	if config.RequireStrongPasswords {
		for _, credential := range []struct{ name, password string }{
			{name: "VYLK_PASSWORD", password: config.Password},
			{name: "VYLK_ENCRYPTION_PASSWORD", password: config.EncryptionPassword},
		} {
			if credential.password != "" && zxcvbn.PasswordStrength(credential.password, nil).Score < 4 {
				return fmt.Errorf("%s must be strong when VYLK_REQUIRE_STRONG_PASSWORDS is enabled", credential.name)
			}
		}
	}
	return nil
}

func loadRuntimeConfig(args []string, getenv func(string) string, secret func(string) (string, error)) (runtimeConfig, error) {
	appName, err := web.ConfiguredName(getenv(web.NameEnv))
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("app name: %w", err)
	}
	password, err := secret("VYLK_PASSWORD")
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("password: %w", err)
	}
	encryptionPassword, err := secret("VYLK_ENCRYPTION_PASSWORD")
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("encryption password: %w", err)
	}
	encryptionKey, err := secret("VYLK_ENCRYPTION_KEY")
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("encryption key: %w", err)
	}
	requireStrongPasswords, err := strconv.ParseBool(valueOrDefault(getenv("VYLK_REQUIRE_STRONG_PASSWORDS"), "false"))
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("VYLK_REQUIRE_STRONG_PASSWORDS must be true, false, 1, or 0: %w", err)
	}
	return runtimeConfig{
		AppName:                appName,
		Password:               password,
		Port:                   valueOrDefault(getenv("PORT"), "8080"),
		NotesDir:               valueOrDefault(getenv("VYLK_DIR"), "./notes"),
		DatabasePath:           valueOrDefault(getenv("VYLK_DB"), "./vylk.db"),
		TrustProxy:             getenv("VYLK_TRUST_PROXY") == "1",
		EncryptionPassword:     encryptionPassword,
		EncryptionKey:          encryptionKey,
		MigrateEncryption:      getenv("VYLK_MIGRATE_ENCRYPTION") == "1",
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
// reusable encryption or login secret in the process environment. A final line
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
