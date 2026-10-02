package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSyncPushRejectsReplacedDatabaseBeforeAccessingStorage(t *testing.T) {
	a := &app{instanceID: "replacement"}
	for name, handler := range map[string]http.HandlerFunc{
		"legacy":    a.handleSyncPush,
		"encrypted": a.handleVaultSyncPush,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/sync/push", strings.NewReader(`{"device_id":"device_a","operations":[{"type":"noop","client_sequence":1,"op_id":"op_a"}]}`))
			request.Header.Set("X-Vylk-Instance-ID", "original")
			response := httptest.NewRecorder()
			// Deliberately no database: rejection must precede any storage access.
			handler(response, request)
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"server_instance_changed"`) {
				t.Fatalf("response = %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestServerInstanceFenceAcceptsMatchingAndLegacyClients(t *testing.T) {
	a := &app{instanceID: "current"}
	for _, identity := range []string{"", "current"} {
		request := httptest.NewRequest(http.MethodPost, "/api/sync/push", nil)
		request.Header.Set("X-Vylk-Instance-ID", identity)
		if !a.requireServerInstance(httptest.NewRecorder(), request) {
			t.Fatalf("rejected identity %q", identity)
		}
	}
}
