package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"vylk/internal/event"
	"vylk/internal/store"
)

func (a *app) publishChange(kind string) {
	if a.events == nil {
		return
	}
	change := event.Change{Type: kind}
	if a.db != nil {
		if kind == "notes" {
			_ = a.db.QueryRow("SELECT COALESCE(MAX(sequence), 0) FROM sync_changes").Scan(&change.Sequence)
		} else if kind == "preferences" {
			if current, err := store.GetPrefs(a.db); err == nil {
				change.Revision = current.Revision
			}
		}
	}
	a.events.Publish(change)
}

const (
	sseHeartbeatInterval = 25 * time.Second
	sseReconnectDelay    = 3 * time.Second
	sseWriteTimeout      = 10 * time.Second
)

func writeSSEHeartbeat(w io.Writer) error {
	_, err := io.WriteString(w, "event: heartbeat\ndata: {}\n\n")
	return err
}

func writeSSEChange(w io.Writer, change event.Change) error {
	data, err := json.Marshal(change)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: change\ndata: %s\n\n", data)
	return err
}

func writeSSEServerInfo(w io.Writer) error {
	data, err := json.Marshal(map[string]string{"version": version, "revision": appRevision})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: server\ndata: %s\n\n", data)
	return err
}

func setSSEWriteDeadline(w http.ResponseWriter) error {
	err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(sseWriteTimeout))
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

// handleEvents keeps an authenticated stream open for reachability and tiny
// change hints. Mutations and note content continue to use normal HTTP sync.
func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}

	// Reset a short write deadline before each heartbeat. This lets the stream
	// outlive the server's normal request timeout without allowing a stalled
	// client to hold a goroutine forever.
	if err := setSSEWriteDeadline(w); err != nil {
		http.Error(w, "could not configure stream deadline", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	var changes chan event.Change
	if a.events != nil {
		changes = a.events.Subscribe()
		defer a.events.Unsubscribe(changes)
	}
	if _, err := io.WriteString(w, "retry: 3000\n\n"); err != nil {
		return
	}
	if err := writeSSEServerInfo(w); err != nil {
		return
	}
	if err := writeSSEHeartbeat(w); err != nil {
		return
	}
	flusher.Flush()

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := setSSEWriteDeadline(w); err != nil {
				return
			}
			if err := writeSSEHeartbeat(w); err != nil {
				return
			}
			flusher.Flush()
		case event := <-changes:
			if err := setSSEWriteDeadline(w); err != nil {
				return
			}
			if err := writeSSEChange(w, event); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
