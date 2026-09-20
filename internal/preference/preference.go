// Package preference owns the user preference model, validation, and
// conflict-aware patching used by direct and synchronized updates.
package preference

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

type Preferences struct {
	Revision                  int64                       `json:"revision,omitempty"`
	AutoSave                  bool                        `json:"autoSave"`
	StartView                 string                      `json:"startView,omitempty"`
	HideToolbar               bool                        `json:"hideToolbar"`
	HideSaveButton            bool                        `json:"hideSaveButton"`
	SaveButtonLocation        string                      `json:"saveButtonLocation,omitempty"`
	CollapseDetails           bool                        `json:"collapseDetails"`
	HideCursorHighlight       bool                        `json:"hideCursorHighlight"`
	InteractivePreview        bool                        `json:"interactivePreview"`
	StatusDisplay             string                      `json:"statusDisplay,omitempty"`
	ContentWidth              string                      `json:"contentWidth,omitempty"`
	ZenPageWidth              string                      `json:"zenPageWidth,omitempty"`
	Theme                     string                      `json:"theme,omitempty"`
	AccentColor               string                      `json:"accentColor,omitempty"`
	FontFamily                string                      `json:"fontFamily,omitempty"`
	FontFamilyGoogle          bool                        `json:"fontFamilyGoogle"`
	FontSize                  string                      `json:"fontSize,omitempty"`
	EditorFontFamily          string                      `json:"editorFontFamily,omitempty"`
	EditorFontFamilyGoogle    bool                        `json:"editorFontFamilyGoogle"`
	EditorFontSize            string                      `json:"editorFontSize,omitempty"`
	PreviewFontFamily         string                      `json:"previewFontFamily,omitempty"`
	PreviewFontFamilyGoogle   bool                        `json:"previewFontFamilyGoogle"`
	PreviewFontSize           string                      `json:"previewFontSize,omitempty"`
	ZenFontFamily             string                      `json:"zenFontFamily,omitempty"`
	ZenFontFamilyGoogle       bool                        `json:"zenFontFamilyGoogle"`
	ZenFontSize               string                      `json:"zenFontSize,omitempty"`
	ZenWordCount              bool                        `json:"zenWordCount"`
	ZenShowTitle              bool                        `json:"zenShowTitle"`
	ZenShowControls           bool                        `json:"zenShowControls"`
	ZenInteractivePreview     bool                        `json:"zenInteractivePreview"`
	ShortcutPrefix            ShortcutBinding             `json:"shortcutPrefix"`
	KeyboardShortcuts         map[string]*ShortcutBinding `json:"keyboardShortcuts"`
	ShortcutConfirmationSkips map[string]bool             `json:"shortcutConfirmationSkips"`
	SyncPatch                 map[string]json.RawMessage  `json:"_sync_patch,omitempty"`
	SyncBase                  map[string]json.RawMessage  `json:"_sync_base,omitempty"`
}

type ShortcutStep struct {
	Key       string   `json:"key"`
	Modifiers []string `json:"modifiers"`
}

type ShortcutBinding struct {
	Steps []ShortcutStep `json:"steps"`
}

var defaultShortcutPrefix = ShortcutBinding{Steps: []ShortcutStep{{Key: "/", Modifiers: []string{"Mod"}}}}

func Defaults() *Preferences {
	return &Preferences{
		AutoSave:                  true,
		SaveButtonLocation:        "panel",
		ContentWidth:              "standard",
		ZenPageWidth:              "standard",
		FontSize:                  "1rem",
		EditorFontSize:            "1rem",
		PreviewFontSize:           "1rem",
		ZenFontSize:               "1rem",
		ZenShowTitle:              true,
		ZenShowControls:           true,
		ShortcutPrefix:            defaultShortcutPrefix,
		KeyboardShortcuts:         map[string]*ShortcutBinding{},
		ShortcutConfirmationSkips: map[string]bool{},
	}
}

var fieldNames = map[string]struct{}{
	"autoSave": {}, "startView": {}, "hideToolbar": {}, "hideSaveButton": {},
	"saveButtonLocation": {}, "collapseDetails": {}, "hideCursorHighlight": {},
	"interactivePreview": {}, "statusDisplay": {}, "contentWidth": {},
	"zenPageWidth": {}, "theme": {}, "accentColor": {}, "fontFamily": {},
	"fontFamilyGoogle": {}, "fontSize": {}, "editorFontFamily": {},
	"editorFontFamilyGoogle": {}, "editorFontSize": {}, "previewFontFamily": {},
	"previewFontFamilyGoogle": {}, "previewFontSize": {}, "zenFontFamily": {},
	"zenFontFamilyGoogle": {}, "zenFontSize": {}, "zenWordCount": {},
	"zenShowTitle": {}, "zenShowControls": {}, "zenInteractivePreview": {},
	"shortcutPrefix": {}, "keyboardShortcuts": {}, "shortcutConfirmationSkips": {},
}

var shortcutCommandIDPattern = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,63}$`)
var shortcutKeyPattern = regexp.MustCompile(`^[A-Za-z0-9/;]$`)

var fontSizes = map[string]struct{}{
	"0.8rem": {}, "0.9rem": {}, "1rem": {}, "1.1rem": {}, "1.25rem": {}, "1.5rem": {},
}

func validContentWidth(value string) bool {
	switch value {
	case "compact", "standard", "wide", "full":
		return true
	default:
		return false
	}
}

func validStartView(value string) bool {
	switch value {
	case "editor", "preview", "split", "zen":
		return true
	default:
		return false
	}
}

func validSaveButtonLocation(value string) bool {
	return value == "panel" || value == "header"
}

func validFontSize(value string) bool {
	_, ok := fontSizes[strings.TrimSpace(value)]
	return ok
}

func validShortcutBinding(binding *ShortcutBinding) bool {
	if binding == nil || len(binding.Steps) < 1 || len(binding.Steps) > 2 {
		return false
	}
	for i, step := range binding.Steps {
		if !shortcutKeyPattern.MatchString(step.Key) {
			return false
		}
		modifiers := strings.Join(step.Modifiers, ",")
		if i == 0 && modifiers != "Mod" && modifiers != "Mod,Shift" {
			return false
		}
		if i == 1 && len(step.Modifiers) != 0 {
			return false
		}
	}
	return true
}

func validShortcutPrefix(binding ShortcutBinding) bool {
	return len(binding.Steps) == 1 && validShortcutBinding(&binding)
}

func validKeyboardShortcuts(value map[string]*ShortcutBinding) bool {
	if len(value) > 64 {
		return false
	}
	for id, binding := range value {
		if !shortcutCommandIDPattern.MatchString(id) || (binding != nil && !validShortcutBinding(binding)) {
			return false
		}
	}
	return true
}

func validShortcutConfirmationSkips(value map[string]bool) bool {
	if len(value) > 64 {
		return false
	}
	for id, skip := range value {
		if !shortcutCommandIDPattern.MatchString(id) || !skip {
			return false
		}
	}
	return true
}

func ValidateField(key string, value json.RawMessage) error {
	if _, ok := fieldNames[key]; !ok {
		return fmt.Errorf("unknown preference field %q", key)
	}
	switch key {
	case "startView":
		var v string
		if err := json.Unmarshal(value, &v); err != nil || !validStartView(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	case "contentWidth", "zenPageWidth":
		var v string
		if err := json.Unmarshal(value, &v); err != nil || !validContentWidth(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	case "saveButtonLocation":
		var v string
		if err := json.Unmarshal(value, &v); err != nil || !validSaveButtonLocation(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	case "fontSize", "editorFontSize", "previewFontSize", "zenFontSize":
		var v string
		if err := json.Unmarshal(value, &v); err != nil || !validFontSize(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	case "keyboardShortcuts":
		var v map[string]*ShortcutBinding
		if err := json.Unmarshal(value, &v); err != nil || !validKeyboardShortcuts(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	case "shortcutPrefix":
		var v ShortcutBinding
		if err := json.Unmarshal(value, &v); err != nil || !validShortcutPrefix(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	case "shortcutConfirmationSkips":
		var v map[string]bool
		if err := json.Unmarshal(value, &v); err != nil || !validShortcutConfirmationSkips(v) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	}
	return nil
}

func Validate(p *Preferences) error {
	if p.StartView == "" {
		p.StartView = "split"
	}
	if len(p.ShortcutPrefix.Steps) == 0 {
		p.ShortcutPrefix = defaultShortcutPrefix
	}
	if p.KeyboardShortcuts == nil {
		p.KeyboardShortcuts = map[string]*ShortcutBinding{}
	}
	if p.ShortcutConfirmationSkips == nil {
		p.ShortcutConfirmationSkips = map[string]bool{}
	}
	if p.ContentWidth != "" && !validContentWidth(p.ContentWidth) {
		return fmt.Errorf("invalid preference value for %q", "contentWidth")
	}
	if p.ZenPageWidth != "" && !validContentWidth(p.ZenPageWidth) {
		return fmt.Errorf("invalid preference value for %q", "zenPageWidth")
	}
	if !validStartView(p.StartView) {
		return fmt.Errorf("invalid preference value for %q", "startView")
	}
	if p.SaveButtonLocation != "" && !validSaveButtonLocation(p.SaveButtonLocation) {
		return fmt.Errorf("invalid preference value for %q", "saveButtonLocation")
	}
	for key, value := range map[string]string{
		"fontSize": p.FontSize, "editorFontSize": p.EditorFontSize,
		"previewFontSize": p.PreviewFontSize, "zenFontSize": p.ZenFontSize,
	} {
		if value != "" && !validFontSize(value) {
			return fmt.Errorf("invalid preference value for %q", key)
		}
	}
	if !validKeyboardShortcuts(p.KeyboardShortcuts) {
		return fmt.Errorf("invalid preference value for %q", "keyboardShortcuts")
	}
	if !validShortcutPrefix(p.ShortcutPrefix) {
		return fmt.Errorf("invalid preference value for %q", "shortcutPrefix")
	}
	if !validShortcutConfirmationSkips(p.ShortcutConfirmationSkips) {
		return fmt.Errorf("invalid preference value for %q", "shortcutConfirmationSkips")
	}
	return nil
}

func ValidatePatch(patch map[string]json.RawMessage) error {
	for key, value := range patch {
		if err := ValidateField(key, value); err != nil {
			return err
		}
	}
	return nil
}

func Fields(p *Preferences) (map[string]json.RawMessage, error) {
	encoded, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	fields := make(map[string]json.RawMessage)
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	delete(fields, "revision")
	delete(fields, "_sync_patch")
	delete(fields, "_sync_base")
	return fields, nil
}

func PatchConflicts(current, operation *Preferences) (bool, error) {
	currentFields, err := Fields(current)
	if err != nil {
		return false, err
	}
	for key, desired := range operation.SyncPatch {
		if _, ok := fieldNames[key]; !ok {
			return false, fmt.Errorf("unknown preference field %q", key)
		}
		base, ok := operation.SyncBase[key]
		if !ok {
			return true, nil
		}
		currentValue, exists := currentFields[key]
		if !exists {
			currentValue = json.RawMessage(`""`)
		}
		if !jsonEqual(currentValue, base) && !jsonEqual(currentValue, desired) {
			return true, nil
		}
	}
	return false, nil
}

func ApplyPatch(current *Preferences, patch map[string]json.RawMessage) (*Preferences, error) {
	fields, err := Fields(current)
	if err != nil {
		return nil, err
	}
	for key, value := range patch {
		if err := ValidateField(key, value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	var next Preferences
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&next); err != nil {
		return nil, err
	}
	next.Revision = current.Revision
	return &next, nil
}

func jsonEqual(left, right json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(left), bytes.TrimSpace(right))
}
