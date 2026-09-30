package server

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"vylk/internal/httpx"
	"vylk/internal/store"
)

type vaultCredentialRequest struct {
	Kind            string          `json:"kind"`
	CurrentProof    string          `json:"current_proof"`
	CurrentRecovery bool            `json:"current_recovery"`
	NewProof        string          `json:"new_proof"`
	WrappedKey      json.RawMessage `json:"wrapped_key"`
	KDFSalt         string          `json:"kdf_salt"`
	KDFMemoryKiB    int             `json:"kdf_memory_kib"`
	KDFIterations   int             `json:"kdf_iterations"`
	SignOutOthers   *bool           `json:"sign_out_other_devices"`
}

func (a *app) handleVaultCredentialChange(w http.ResponseWriter, r *http.Request) {
	var request vaultCredentialRequest
	if !httpx.DecodeJSON(w, r, &request, 32<<10) {
		return
	}
	current, validCurrent := decodeVaultProof(request.CurrentProof)
	next, validNext := decodeVaultProof(request.NewProof)
	if !validCurrent || !validNext || !validVaultEnvelope(request.WrappedKey) ||
		(request.Kind != "master" && request.Kind != "recovery") {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_vault_credentials", "invalid vault credential change")
		return
	}
	if request.Kind == "master" {
		if _, ok := decodeVaultIdentifier(request.KDFSalt); !ok ||
			request.KDFMemoryKiB < 19*1024 || request.KDFMemoryKiB > 256*1024 ||
			request.KDFIterations < 2 || request.KDFIterations > 10 {
			httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_vault_kdf", "invalid vault key derivation settings")
			return
		}
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	config, err := store.GetVaultConfig(a.db)
	if err != nil || config == nil || config.Mode != store.VaultReady {
		httpx.WriteAPIError(w, http.StatusConflict, "vault_unavailable", "encrypted vault is unavailable")
		return
	}
	expected := config.AuthHash
	if request.CurrentRecovery {
		expected = config.RecoveryHash
	}
	if subtle.ConstantTimeCompare(vaultProofHash(current), expected) != 1 {
		httpx.WriteAPIError(w, http.StatusUnauthorized, "invalid_credentials", "current vault credential is incorrect")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "credential_change_failed", "could not update vault credentials")
		return
	}
	defer tx.Rollback()
	if request.Kind == "master" {
		_, err = tx.Exec(`UPDATE vault_config SET kdf_salt = ?, kdf_memory_kib = ?,
			kdf_iterations = ?, auth_hash = ?, wrapped_key = ? WHERE id = 1`,
			request.KDFSalt, request.KDFMemoryKiB, request.KDFIterations,
			vaultProofHash(next), string(request.WrappedKey))
	} else {
		_, err = tx.Exec(`UPDATE vault_config SET recovery_hash = ?, wrapped_recovery_key = ? WHERE id = 1`,
			vaultProofHash(next), string(request.WrappedKey))
	}
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "credential_change_failed", "could not update vault credentials")
		return
	}
	if err := a.sessions.RevokeCredentials(tx, sessionToken(r), request.SignOutOthers == nil || *request.SignOutOthers); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "credential_change_failed", "could not revoke old sessions")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "credential_change_failed", "could not commit vault credential change")
		return
	}
	// The client obtains a fresh session with the new proof before resuming sync.
	http.SetCookie(w, &http.Cookie{Name: "session", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: a.isSecureRequest(r), SameSite: http.SameSiteLaxMode})
	httpx.WriteJSON(w, map[string]any{"ok": true})
}
