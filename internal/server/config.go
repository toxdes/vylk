package server

import (
	"fmt"
	"os"
	"strings"
	"time"

	"vylk/internal/web"
)

type runtimeConfig struct {
	AppName            string
	Password           string
	Port               string
	NotesDir           string
	DatabasePath       string
	TrustProxy         bool
	EncryptionPassword string
	EncryptionKey      string
	MigrateEncryption  bool
	OpenBrowser        bool
	ArtificialDelay    time.Duration
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
	if password == "" {
		return runtimeConfig{}, fmt.Errorf("VYLK_PASSWORD environment variable is required")
	}
	encryptionPassword, err := secret("VYLK_ENCRYPTION_PASSWORD")
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("encryption password: %w", err)
	}
	encryptionKey, err := secret("VYLK_ENCRYPTION_KEY")
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("encryption key: %w", err)
	}
	return runtimeConfig{
		AppName:            appName,
		Password:           password,
		Port:               valueOrDefault(getenv("PORT"), "8080"),
		NotesDir:           valueOrDefault(getenv("VYLK_DIR"), "./notes"),
		DatabasePath:       valueOrDefault(getenv("VYLK_DB"), "./vylk.db"),
		TrustProxy:         getenv("VYLK_TRUST_PROXY") == "1",
		EncryptionPassword: encryptionPassword,
		EncryptionKey:      encryptionKey,
		MigrateEncryption:  getenv("VYLK_MIGRATE_ENCRYPTION") == "1",
		OpenBrowser:        shouldOpenBrowser(args, getenv),
		ArtificialDelay:    parseArtificialRTTDelay(getenv(artificialRTTDelayEnv)),
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
