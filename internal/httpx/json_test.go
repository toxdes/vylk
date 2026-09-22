package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONAcceptsOneKnownValue(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"note"}`))
	response := httptest.NewRecorder()
	var body struct {
		Name string `json:"name"`
	}

	if !DecodeJSON(response, request, &body, 1024) {
		t.Fatalf("DecodeJSON rejected a valid request: %s", response.Body.String())
	}
	if body.Name != "note" {
		t.Fatalf("decoded name = %q, want note", body.Name)
	}
}

func TestDecodeJSONRejectsUnknownFieldsAndTrailingValues(t *testing.T) {
	t.Parallel()

	for name, input := range map[string]string{
		"unknown field":  `{"name":"note","extra":true}`,
		"trailing value": `{"name":"note"} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(input))
			response := httptest.NewRecorder()
			var body struct {
				Name string `json:"name"`
			}

			if DecodeJSON(response, request, &body, 1024) {
				t.Fatal("DecodeJSON accepted invalid input")
			}
			if response.Code != http.StatusBadRequest || response.Header().Get("Content-Type") != jsonContentType {
				t.Fatalf("response = (%d, %q), want JSON 400", response.Code, response.Header().Get("Content-Type"))
			}
			if response.Body.String() != "{\"code\":\"invalid_request\",\"error\":\"invalid request\"}\n" {
				t.Fatalf("body = %q", response.Body.String())
			}
		})
	}
}
