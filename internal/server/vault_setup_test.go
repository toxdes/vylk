package server

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vylk/internal/auth"
	"vylk/internal/store"
)

func TestSetupPasswordVerificationDoesNotStartMigration(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	limiter, err := auth.NewRateLimiter(db, false)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, password: "existing-password", rl: limiter}
	for _, attempt := range []struct {
		password string
		status   int
	}{
		{"incorrect", 403}, {"existing-password", 200},
	} {
		request := httptest.NewRequest("POST", "/api/vault/setup/verify-password", strings.NewReader(`{"password":"`+attempt.password+`"}`))
		response := httptest.NewRecorder()
		a.handleVaultSetupPassword(response, request)
		if response.Code != attempt.status {
			t.Fatalf("verification: %d %s", response.Code, response.Body.String())
		}
		config, err := store.GetVaultConfig(db)
		if err != nil || config != nil {
			t.Fatalf("verification created vault state: %+v %v", config, err)
		}
		if len(response.Result().Cookies()) != 0 {
			t.Fatal("verification changed the browser session")
		}
	}
}
