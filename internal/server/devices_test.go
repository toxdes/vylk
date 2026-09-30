package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vylk/internal/auth"
	"vylk/internal/web"
)

func TestCredentialChangeRespectsOtherDevicesChoice(t *testing.T) {
	for _, signOutOthers := range []bool{false, true} {
		t.Run(map[bool]string{false: "keep_other_devices", true: "sign_out_other_devices"}[signOutOthers], func(t *testing.T) {
			db, err := openDB(filepath.Join(t.TempDir(), "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := initDB(db); err != nil {
				t.Fatal(err)
			}
			proofBytes := make([]byte, 32)
			proof := base64.RawURLEncoding.EncodeToString(proofBytes)
			id := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
			if _, err := db.Exec(`INSERT INTO vault_config
				(id, mode, vault_id, kdf_salt, kdf_memory_kib, kdf_iterations, auth_hash,
				recovery_hash, wrapped_key, wrapped_recovery_key, epoch)
				VALUES (1, 'encrypted', ?, ?, 19456, 2, ?, ?, ?, ?, 1)`,
				id, id, vaultProofHash(proofBytes), vaultProofHash(proofBytes), string(vaultTestEnvelope()), string(vaultTestEnvelope())); err != nil {
				t.Fatal(err)
			}
			rl, err := auth.NewRateLimiter(db, false)
			if err != nil {
				t.Fatal(err)
			}
			a := &app{db: db, sessions: auth.NewSessionStore(db), rl: rl}
			current, err := a.sessions.Create()
			if err != nil {
				t.Fatal(err)
			}
			other, err := a.sessions.Create()
			if err != nil {
				t.Fatal(err)
			}
			w := vaultTestRequest(t, http.MethodPost, "/api/vault/credentials",
				vaultCredentialRequest{Kind: "master", CurrentProof: proof, NewProof: proof,
					WrappedKey: vaultTestEnvelope(), KDFSalt: id, KDFMemoryKiB: 19456, KDFIterations: 2,
					SignOutOthers: &signOutOthers}, func(w http.ResponseWriter, r *http.Request) {
					r.AddCookie(&http.Cookie{Name: "session", Value: current})
					a.auth(a.handleVaultCredentialChange)(w, r)
				})
			if w.Code != http.StatusOK {
				t.Fatalf("credential change: %d %s", w.Code, w.Body.String())
			}
			if a.sessions.Valid(current) {
				t.Fatal("current session was not replaced")
			}
			if a.sessions.Valid(other) == signOutOthers {
				t.Fatal("other device choice not honored")
			}
		})
	}
}

func TestBrowserDevicesShareIdentityAndRevokeAccess(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	rl, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, sessions: auth.NewSessionStore(db), password: "password", rl: rl}
	assets, err := web.New(web.DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(a, assets, 0)
	login := func(deviceCookie *http.Cookie) (string, *http.Cookie) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"password":"password"}`))
		r.Header.Set("User-Agent", "Mozilla/5.0 (Linux) Firefox/140.0")
		if deviceCookie != nil {
			r.AddCookie(deviceCookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("login: %d %s", w.Code, w.Body.String())
		}
		var token string
		var device *http.Cookie
		for _, cookie := range w.Result().Cookies() {
			if cookie.Name == "session" {
				token = cookie.Value
			}
			if cookie.Name == "vylk-device" {
				device = cookie
			}
		}
		if token == "" || device == nil || !device.HttpOnly {
			t.Fatal("missing browser cookies")
		}
		return token, device
	}
	first, cookie := login(nil)
	second, _ := login(cookie)
	other, otherCookie := login(nil)
	request := func(method, path, token string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		if token != "" {
			r.AddCookie(&http.Cookie{Name: "session", Value: token})
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request(http.MethodGet, "/api/devices", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous list: %d", w.Code)
	}
	w := request(http.MethodGet, "/api/devices", first)
	var result struct {
		Devices []auth.Device `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Devices) != 2 {
		t.Fatalf("device list: %s, %v", w.Body.String(), err)
	}
	if strings.Contains(w.Body.String(), first) || strings.Contains(w.Body.String(), auth.SessionTokenHash(first)) {
		t.Fatal("session credentials exposed")
	}
	if w := request(http.MethodDelete, "/api/devices/not-an-id", first); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid id: %d", w.Code)
	}
	a.disableVaultChanges = true
	if w := request(http.MethodDelete, "/api/devices/"+otherCookie.Value, first); w.Code != http.StatusForbidden {
		t.Fatalf("demo revocation: %d", w.Code)
	}
	a.disableVaultChanges = false
	if w := request(http.MethodDelete, "/api/devices/"+cookie.Value, other); w.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	if a.sessions.Valid(first) || a.sessions.Valid(second) || !a.sessions.Valid(other) {
		t.Fatal("wrong browser revoked")
	}
	if w := request(http.MethodGet, "/api/devices", first); w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked access: %d", w.Code)
	}
}
