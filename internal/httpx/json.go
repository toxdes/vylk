// Package httpx contains the application's reusable HTTP transport helpers.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const jsonContentType = "application/json; charset=utf-8"

// WriteJSON writes a successful JSON response.
func WriteJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", jsonContentType)
	_ = json.NewEncoder(w).Encode(value)
}

// WriteJSONStatus writes a JSON response with the supplied HTTP status.
func WriteJSONStatus(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", jsonContentType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// WriteAPIError writes the stable error envelope used by API clients.
func WriteAPIError(w http.ResponseWriter, status int, code, message string) {
	WriteJSONStatus(w, status, map[string]any{"error": message, "code": code})
}

// DecodeJSON decodes one bounded JSON value and rejects unknown fields or trailing values.
func DecodeJSON(w http.ResponseWriter, r *http.Request, value any, maxBytes int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		WriteAPIError(w, http.StatusBadRequest, "invalid_request", "invalid request")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		WriteAPIError(w, http.StatusBadRequest, "invalid_request", "invalid request")
		return false
	}
	return true
}
