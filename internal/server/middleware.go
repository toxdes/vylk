package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const artificialRTTDelayEnv = "ARTIFICIAL_RTT_DELAY_MS"

type gzipResponseWriter struct {
	http.ResponseWriter
	Writer io.Writer
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	return w.Writer.Write(b)
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Vylk-Shell") == "1" {
			next.ServeHTTP(w, r)
			return
		}
		// Keep dynamic endpoints cheap and do not recompress already-compressed
		// assets. Range responses must stay uncompressed for correct byte ranges.
		if r.Method == http.MethodGet && !strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Add("Vary", "Accept-Encoding")
		}
		if r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/api/") ||
			r.Header.Get("Range") != "" || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			strings.HasSuffix(r.URL.Path, ".png") || strings.HasSuffix(r.URL.Path, ".ico") {
			next.ServeHTTP(w, r)
			return
		}
		gw, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		defer gw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, Writer: gw}, r)
	})
}

// parseArtificialRTTDelay parses the development-only server-side latency
// injection setting. A zero or invalid value disables the delay.
func parseArtificialRTTDelay(raw string) time.Duration {
	milliseconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || milliseconds <= 0 {
		return 0
	}
	const maxDelay = time.Minute
	if milliseconds > int64(maxDelay/time.Millisecond) {
		return maxDelay
	}
	return time.Duration(milliseconds) * time.Millisecond
}

// artificialRTTDelayMiddleware adds one server-side delay to each request.
// SSE is intentionally excluded because /api/events is a long-lived stream.
func artificialRTTDelayMiddleware(delay time.Duration, next http.Handler) http.Handler {
	if delay <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/events" {
			next.ServeHTTP(w, r)
			return
		}
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
			next.ServeHTTP(w, r)
		case <-r.Context().Done():
		}
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self' https: data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; worker-src 'self'; manifest-src 'self'; font-src 'self' https://fonts.gstatic.com")
		next.ServeHTTP(w, r)
	})
}
