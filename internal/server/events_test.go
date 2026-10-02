package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vylk/internal/auth"
	"vylk/internal/event"
)

type deadlineSSERecorder struct {
	*httptest.ResponseRecorder
	deadline     time.Time
	onFirstFlush func()
}

func (w *deadlineSSERecorder) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func (w *deadlineSSERecorder) Write(data []byte) (int, error) {
	if !w.deadline.IsZero() && time.Now().After(w.deadline) {
		return 0, os.ErrDeadlineExceeded
	}
	return w.ResponseRecorder.Write(data)
}

func (w *deadlineSSERecorder) WriteString(data string) (int, error) {
	return w.Write([]byte(data))
}

func (w *deadlineSSERecorder) Flush() {
	w.ResponseRecorder.Flush()
	if hook := w.onFirstFlush; hook != nil {
		w.onFirstFlush = nil
		hook()
	}
}

func TestEventsRevocationRenewsExpiredWriteDeadline(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "vylk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, sessions: auth.NewSessionStore(db), events: event.NewBroker()}
	token, err := a.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	w := &deadlineSSERecorder{ResponseRecorder: httptest.NewRecorder()}
	w.onFirstFlush = func() {
		// Simulate an idle stream beyond its write deadline, without a timed sleep.
		w.deadline = time.Now().Add(-time.Second)
		a.sessions.Remove(token)
		a.events.Publish(event.Change{Type: "notes"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
	r.AddCookie(&http.Cookie{Name: "session", Value: token})
	a.auth(a.handleEvents)(w, r)
	if !strings.Contains(w.Body.String(), "event: session-expired\ndata: {}\n\n") {
		t.Fatalf("revocation notification lost after idle deadline: %s", w.Body.String())
	}
}
