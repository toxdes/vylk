package server

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vylk/internal/auth"
	"vylk/internal/web"
)

func TestLogoutClearsUnknownSessionWithoutRevokingOtherDevices(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessionStore(db)
	token, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	assets, err := web.New(web.DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(&app{db: db, sessions: sessions}, assets, 0)
	for _, cookie := range []string{"", "obsolete-session"} {
		request := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
		request.TLS = &tls.ConnectionState{}
		if cookie != "" {
			request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("logout with cookie %q = %d: %s", cookie, response.Code, response.Body.String())
		}
		cookies := response.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != "session" || cookies[0].MaxAge != -1 || !cookies[0].HttpOnly {
			t.Fatalf("logout cookies = %+v", cookies)
		}
		if !sessions.Valid(token) {
			t.Fatal("unknown session revoked another device")
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	request.TLS = &tls.ConnectionState{}
	request.AddCookie(&http.Cookie{Name: "session", Value: token})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || sessions.Valid(token) {
		t.Fatalf("valid session logout = %d; token remains valid = %v", response.Code, sessions.Valid(token))
	}
}
