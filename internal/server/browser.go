package server

import (
	"io"
	"os/exec"
	"runtime"
)

func shouldOpenBrowser(args []string, getenv func(string) string) bool {
	open := true
	for _, arg := range args {
		if arg == "--no-browser" {
			open = false
		}
	}
	return open && getenv("VYLK_NO_BROWSER") != "1"
}

func browserCommand(goos, targetURL string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{targetURL}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", targetURL}
	default:
		return "xdg-open", []string{targetURL}
	}
}

func openBrowser(targetURL string) error {
	command, args := browserCommand(runtime.GOOS, targetURL)
	process := exec.Command(command, args...)
	process.Stdout = io.Discard
	process.Stderr = io.Discard
	if err := process.Start(); err != nil {
		return err
	}
	go func() { _ = process.Wait() }()
	return nil
}
