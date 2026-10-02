package server

import (
	"encoding/hex"
	"net/http"
	"strings"

	"vylk/internal/httpx"
)

func sessionToken(r *http.Request) string {
	if cookie, err := r.Cookie("session"); err == nil {
		return cookie.Value
	}
	return ""
}

func browserDeviceName(agent string) string {
	browser := "Browser"
	for _, candidate := range []struct{ marker, name string }{
		{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Firefox/", "Firefox"},
		{"Chrome/", "Chrome"}, {"Safari/", "Safari"},
	} {
		if strings.Contains(agent, candidate.marker) {
			browser = candidate.name
			break
		}
	}
	for _, platform := range []struct{ marker, name string }{
		{"Android", "Android"}, {"iPhone", "iPhone"}, {"iPad", "iPad"},
		{"Windows", "Windows"}, {"Macintosh", "macOS"}, {"Linux", "Linux"},
	} {
		if strings.Contains(agent, platform.marker) {
			return browser + " on " + platform.name
		}
	}
	return browser
}

func (a *app) browserDeviceID(r *http.Request) string {
	id := ""
	if cookie, err := r.Cookie("vylk-device"); err == nil {
		if decoded, err := hex.DecodeString(cookie.Value); err == nil && len(decoded) == 16 {
			id = cookie.Value
		}
	}
	// Upgrade older installations using the authenticated session, not tab state.
	if id == "" {
		id, _ = a.sessions.DeviceID(sessionToken(r))
	}
	return id
}

func (a *app) createBrowserSession(w http.ResponseWriter, r *http.Request) (string, error) {
	token, err := a.sessions.CreateDevice(a.browserDeviceID(r), browserDeviceName(r.UserAgent()))
	if err != nil {
		return "", err
	}
	id, err := a.sessions.DeviceID(token)
	if err != nil {
		return "", err
	}
	a.setDeviceCookie(w, r, id)
	return token, nil
}

func (a *app) setDeviceCookie(w http.ResponseWriter, r *http.Request, id string) {
	http.SetCookie(w, &http.Cookie{Name: "vylk-device", Value: id, Path: "/", HttpOnly: true,
		Secure: a.isSecureRequest(r), SameSite: http.SameSiteLaxMode, MaxAge: 365 * 24 * 60 * 60})
}

func (a *app) handleDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := a.sessions.Devices(sessionToken(r))
	if err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "devices_unavailable", "could not load devices")
		return
	}
	httpx.WriteJSON(w, map[string]any{"devices": devices})
}

func (a *app) handleSignOutDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if decoded, err := hex.DecodeString(id); err != nil || len(decoded) != 16 {
		httpx.WriteAPIError(w, http.StatusBadRequest, "invalid_device", "invalid device")
		return
	}
	if err := a.sessions.RevokeDevice(id); err != nil {
		httpx.WriteAPIError(w, http.StatusInternalServerError, "device_signout_failed", "could not sign out device")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
