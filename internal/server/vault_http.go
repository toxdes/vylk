package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"vylk/internal/httpx"
	notepkg "vylk/internal/note"
	"vylk/internal/store"
)

func (a *app) handleVaultBootstrap(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	config, err := store.GetVaultConfig(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
		return
	}
	if config == nil {
		httpx.WriteJSON(w, map[string]any{
			"mode": "legacy", "reset_available": false,
			"require_strong_passwords": a.requireStrongPasswords,
			"version":                  version, "revision": appRevision, "instance_id": a.instanceID,
		})
		return
	}
	httpx.WriteJSON(w, map[string]any{
		"mode": config.Mode, "vault_id": config.VaultID, "epoch": config.Epoch,
		"version": version, "revision": appRevision, "instance_id": a.instanceID,
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
	// Each legacy metadata byte can expand to six JSON escape bytes. Account
	// for base64 expansion, the authentication tag, and envelope/field overhead.
	const maxSummaryBytes = (notepkg.MaxTitleBytes+notepkg.MaxTagsBytes)*6*4/3 + 1024
	return len(raw) <= maxSummaryBytes && validVaultEnvelope(raw)
}
