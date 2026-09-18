package main

import "testing"

func TestShouldOpenBrowser(t *testing.T) {
	getenv := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}

	tests := []struct {
		name string
		args []string
		env  map[string]string
		want bool
	}{
		{name: "enabled by default", env: map[string]string{}, want: true},
		{name: "command line disable", args: []string{"--no-browser"}, env: map[string]string{}},
		{name: "environment disable", env: map[string]string{"VYLK_NO_BROWSER": "1"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldOpenBrowser(test.args, getenv(test.env)); got != test.want {
				t.Fatalf("shouldOpenBrowser() = %t, want %t", got, test.want)
			}
		})
	}
}

func TestBrowserCommand(t *testing.T) {
	tests := []struct {
		goos string
		name string
		args []string
	}{
		{goos: "linux", name: "xdg-open", args: []string{"http://127.0.0.1:8080/"}},
		{goos: "darwin", name: "open", args: []string{"http://127.0.0.1:8080/"}},
		{goos: "windows", name: "rundll32", args: []string{"url.dll,FileProtocolHandler", "http://127.0.0.1:8080/"}},
	}

	for _, test := range tests {
		t.Run(test.goos, func(t *testing.T) {
			name, args := browserCommand(test.goos, test.args[len(test.args)-1])
			if name != test.name {
				t.Fatalf("browserCommand() name = %q, want %q", name, test.name)
			}
			if len(args) != len(test.args) {
				t.Fatalf("browserCommand() args = %#v, want %#v", args, test.args)
			}
			for index := range args {
				if args[index] != test.args[index] {
					t.Fatalf("browserCommand() args = %#v, want %#v", args, test.args)
				}
			}
		})
	}
}
