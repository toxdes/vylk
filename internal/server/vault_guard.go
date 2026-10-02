package server

import (
	"net/http"

	"vylk/internal/httpx"
	"vylk/internal/store"
)

// requireLegacyWrite must run under noteMu: migration can change the route's
// mode while a previously admitted request is still decoding its body.
func (a *app) requireLegacyWrite(w http.ResponseWriter) bool {
	config, err := store.GetVaultConfig(a.db)
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
		return false
	}
	if config == nil {
		return true
	}
	if config.Mode == store.VaultReady {
		httpx.WriteAPIError(w, http.StatusUpgradeRequired, "encrypted_client_required", "update Vylk to sync this encrypted vault")
	} else if config.Mode == store.VaultPreparing {
		httpx.WriteAPIError(w, http.StatusLocked, "vault_migration_in_progress", "note writes are paused for encryption")
	} else {
		httpx.WriteAPIError(w, http.StatusLocked, "vault_maintenance_in_progress", "vault maintenance is in progress")
	}
	return false
}

// vaultRoute keeps the legacy and encrypted API contracts disjoint. In
// particular, a missing encrypted handler fails closed rather than reaching a
// plaintext-capable legacy handler after cutover.
func (a *app) vaultRoute(legacy, encrypted http.HandlerFunc, write bool) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request) {
		config, err := store.GetVaultConfig(a.db)
		if err != nil {
			httpx.WriteAPIError(w, http.StatusInternalServerError, "vault_status_failed", "could not read vault status")
			return
		}
		if config == nil {
			legacy(w, r)
			return
		}
		if config.Mode == store.VaultPreparing {
			if write {
				httpx.WriteAPIError(w, http.StatusLocked, "vault_migration_in_progress", "note writes are paused for encryption")
				return
			}
			legacy(w, r)
			return
		}
		if config.Mode != store.VaultReady {
			httpx.WriteAPIError(w, http.StatusLocked, "vault_maintenance_in_progress", "vault maintenance is in progress")
			return
		}
		if r.Header.Get("X-Vylk-Vault-Protocol") != "1" {
			httpx.WriteAPIError(w, http.StatusUpgradeRequired, "encrypted_client_required", "update Vylk to sync this encrypted vault")
			return
		}
		if encrypted == nil {
			httpx.WriteAPIError(w, http.StatusServiceUnavailable, "encrypted_endpoint_unavailable", "encrypted endpoint is unavailable")
			return
		}
		encrypted(w, r)
	})
}

func (a *app) vaultChange(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.disableVaultChanges {
			httpx.WriteAPIError(w, http.StatusForbidden, "vault_changes_disabled", "vault changes are disabled on this instance")
			return
		}
		next(w, r)
	}
}
