package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vylk/internal/store"
)

func TestVaultBootstrapExposesDatabaseIdentityWithoutAuthentication(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	id, err := store.InstanceID(db)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, instanceID: id}
	for _, mode := range []string{"legacy", "encrypted"} {
		if mode == "encrypted" {
			_, err := db.Exec(`INSERT INTO vault_config (id, mode, vault_id, kdf_salt, kdf_memory_kib, kdf_iterations, auth_hash, recovery_hash, wrapped_key, wrapped_recovery_key, epoch) VALUES (1, 'encrypted', 'vault', 'salt', 19456, 2, x'01', x'02', '{}', '{}', 1)`)
			if err != nil {
				t.Fatal(err)
			}
		}
		t.Run(mode, func(t *testing.T) {
			response := httptest.NewRecorder()
			a.handleVaultBootstrap(response, httptest.NewRequest(http.MethodGet, "/api/vault/bootstrap", nil))
			if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response = %d, headers = %v", response.Code, response.Header())
			}
			var result struct {
				InstanceID string `json:"instance_id"`
				Mode       string `json:"mode"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.InstanceID != id || result.Mode != mode {
				t.Fatalf("bootstrap = %+v", result)
			}
		})
	}
}
