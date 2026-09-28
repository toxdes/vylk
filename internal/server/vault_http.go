package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"vylk/internal/httpx"
	"vylk/internal/store"
)

func (a *app) handleVaultBootstrap(w http.ResponseWriter, r *http.Request) {
	config, err := store.GetVaultConfig(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
		return
	}
	if config == nil {
		httpx.WriteJSON(w, map[string]any{
			"mode": "legacy", "reset_available": false,
			"require_strong_passwords": a.requireStrongPasswords,
			"version":                  version, "revision": appRevision,
		})
		return
	}
	httpx.WriteJSON(w, map[string]any{
		"mode": config.Mode, "vault_id": config.VaultID, "epoch": config.Epoch,
		"version": version, "revision": appRevision,
		"reset_available":          a.password != "" && config.Mode == store.VaultReady,
		"require_strong_passwords": a.requireStrongPasswords,
		"kdf": map[string]any{"algorithm": "argon2id13", "salt": config.KDFSalt,
			"memoryKiB": config.KDFMemoryKiB, "iterations": config.KDFIterations},
	})
}

func (a *app) handleVaultKeys(w http.ResponseWriter, r *http.Request) {
	config, err := store.GetVaultConfig(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
		return
	}
	if config == nil {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_not_encrypted", "vault encryption is not active")
		return
	}
	httpx.WriteJSON(w, map[string]any{
		"vault_id": config.VaultID, "epoch": config.Epoch,
		"wrapped_key":          json.RawMessage(config.WrappedKey),
		"wrapped_recovery_key": json.RawMessage(config.WrappedRecoveryKey),
	})
}

func decodeVaultProof(value string) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return decoded, err == nil && len(decoded) == 32
}

func decodeVaultIdentifier(value string) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return decoded, err == nil && len(decoded) == 16
}

func validVaultEnvelope(raw json.RawMessage) bool {
	var envelope struct {
		Version    int    `json:"v"`
		Nonce      string `json:"nonce"`
		Ciphertext string `json:"ciphertext"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Version != 1 {
		return false
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Nonce)
	if err != nil || len(nonce) != 12 {
		return false
	}
	ciphertext, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Ciphertext)
	return err == nil && len(ciphertext) >= 16
}

func validVaultSummary(raw json.RawMessage) bool {
	// Legacy titles and tags are capped at 512 and 4096 bytes respectively.
	// Leave room for JSON escaping and the authenticated encryption envelope.
	return len(raw) <= 16<<10 && validVaultEnvelope(raw)
}
