package preference

import (
	"encoding/json"
	"testing"
)

func TestWritingDefaults(t *testing.T) {
	p := Defaults()
	if p.StartView != "editor" || !p.InteractivePreview || p.HideToolbar || !p.HideSaveButton {
		t.Fatalf("unexpected editor defaults: %+v", p)
	}
	if p.ZenFontFamily != "Inter" || !p.ZenFontFamilyGoogle || p.ZenFontSize != "1.25rem" || !p.ZenWordCount || !p.ZenShowTitle || !p.ZenShowControls {
		t.Fatalf("unexpected Zen defaults: %+v", p)
	}
	if len(p.ShortcutPrefix.Steps) != 1 || p.ShortcutPrefix.Steps[0].Key != "e" || len(p.ShortcutPrefix.Steps[0].Modifiers) != 1 || p.ShortcutPrefix.Steps[0].Modifiers[0] != "Mod" {
		t.Fatalf("unexpected shortcut prefix: %+v", p.ShortcutPrefix)
	}
	if err := Validate(p); err != nil {
		t.Fatal(err)
	}
}

func TestSavedChoicesOverrideDefaults(t *testing.T) {
	p := Defaults()
	err := json.Unmarshal([]byte(`{"startView":"split","interactivePreview":false,"hideSaveButton":false,"zenFontFamily":"system-monospace","zenFontFamilyGoogle":false,"zenFontSize":"1rem","zenWordCount":false,"zenShowTitle":false,"zenShowControls":false,"shortcutPrefix":{"steps":[{"key":"/","modifiers":["Mod"]}]}}`), p)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(p); err != nil {
		t.Fatal(err)
	}
	if p.StartView != "split" || p.InteractivePreview || p.HideSaveButton || p.ZenFontFamily != "system-monospace" || p.ZenFontFamilyGoogle || p.ZenFontSize != "1rem" || p.ZenWordCount || p.ZenShowTitle || p.ZenShowControls || p.ShortcutPrefix.Steps[0].Key != "/" {
		t.Fatalf("saved choices were overwritten: %+v", p)
	}
}

func TestReduceMotion(t *testing.T) {
	for _, value := range []string{"system", "always", "never"} {
		p := Defaults()
		p.ReduceMotion = value
		if err := Validate(p); err != nil {
			t.Fatalf("%s: %v", value, err)
		}
		if err := ValidateField("reduceMotion", json.RawMessage(`"`+value+`"`)); err != nil {
			t.Fatalf("%s: %v", value, err)
		}
	}
	p := Defaults()
	p.ReduceMotion = "invalid"
	if Validate(p) == nil || ValidateField("reduceMotion", json.RawMessage(`"invalid"`)) == nil {
		t.Fatal("invalid motion choice accepted")
	}
}
