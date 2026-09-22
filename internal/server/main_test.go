package server

import (
	"testing"
	"time"
)

func TestLoadRuntimeConfigAppliesDefaults(t *testing.T) {
	values := map[string]string{"VYLK_PASSWORD": "secret"}
	getenv := func(key string) string { return values[key] }
	config, err := loadRuntimeConfig(nil, getenv, func(name string) (string, error) {
		return getenv(name), nil
	})
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}
	if config.AppName != "VYLK" || config.Port != "8080" || config.NotesDir != "./notes" || config.DatabasePath != "./vylk.db" {
		t.Fatalf("default runtime config = %#v", config)
	}
	if !config.OpenBrowser {
		t.Fatal("default runtime config disabled browser launch")
	}
}

func TestLoadRuntimeConfigReadsOperationalSettings(t *testing.T) {
	values := map[string]string{
		"VYLK_PASSWORD":           "secret",
		"VYLK_APP_NAME":           "Acme Notes",
		"PORT":                    "9090",
		"VYLK_DIR":                "/notes",
		"VYLK_DB":                 "/data/vylk.db",
		"VYLK_TRUST_PROXY":        "1",
		"VYLK_MIGRATE_ENCRYPTION": "1",
		"ARTIFICIAL_RTT_DELAY_MS": "25",
	}
	getenv := func(key string) string { return values[key] }
	config, err := loadRuntimeConfig([]string{"--no-browser"}, getenv, func(name string) (string, error) {
		return getenv(name), nil
	})
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}
	if config.AppName != "Acme Notes" || config.Port != "9090" || config.NotesDir != "/notes" || config.DatabasePath != "/data/vylk.db" {
		t.Fatalf("runtime config = %#v", config)
	}
	if !config.TrustProxy || !config.MigrateEncryption || config.OpenBrowser || config.ArtificialDelay != 25*time.Millisecond {
		t.Fatalf("runtime flags = %#v", config)
	}
}

func TestLoadRuntimeConfigRequiresPassword(t *testing.T) {
	_, err := loadRuntimeConfig(nil, func(string) string { return "" }, func(string) (string, error) { return "", nil })
	if err == nil {
		t.Fatal("loadRuntimeConfig() accepted an empty password")
	}
}

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
