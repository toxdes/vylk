package server

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"vylk/internal/ai"
	"vylk/internal/notesync"
	"vylk/internal/preference"
)

func apiReference(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile("../../docs/api/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	return document
}

func TestAPIReferenceRoutes(t *testing.T) {
	document := apiReference(t)
	if document["openapi"] != "3.1.0" {
		t.Fatal("expected OpenAPI 3.1.0")
	}
	file, err := parser.ParseFile(token.NewFileSet(), "router.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	registered := map[string]bool{}
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || (selector.Sel.Name != "HandleFunc" && selector.Sel.Name != "Handle") {
			return true
		}
		literal, ok := call.Args[0].(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		pattern, err := strconv.Unquote(literal.Value)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(pattern, " /api/") {
			registered[pattern] = true
		}
		return true
	})
	documented := map[string]bool{}
	operationIDs := map[string]bool{}
	for path, item := range document["paths"].(map[string]any) {
		for method, value := range item.(map[string]any) {
			operation := value.(map[string]any)
			pattern := strings.ToUpper(method) + " " + path
			documented[pattern] = true
			id, _ := operation["operationId"].(string)
			if id == "" || operationIDs[id] {
				t.Errorf("%s: missing or duplicate operationId %q", pattern, id)
			}
			operationIDs[id] = true
			if operation["summary"] == nil || operation["responses"] == nil {
				t.Errorf("%s: summary and responses required", pattern)
				continue
			}
			success := false
			for status := range operation["responses"].(map[string]any) {
				if strings.HasPrefix(status, "2") {
					success = true
				}
			}
			if !success {
				t.Errorf("%s: no success response", pattern)
			}
		}
	}
	for pattern := range registered {
		if !documented[pattern] {
			t.Errorf("undocumented route: %s", pattern)
		}
	}
	for pattern := range documented {
		if !registered[pattern] {
			t.Errorf("documented route is not registered: %s", pattern)
		}
	}
}

func TestAPIReferenceReferences(t *testing.T) {
	document := apiReference(t)
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			if ref, ok := value["$ref"].(string); ok {
				if !strings.HasPrefix(ref, "#/") {
					t.Errorf("reference must be local for offline builds: %s", ref)
					return
				}
				var target any = document
				for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
					part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
					object, ok := target.(map[string]any)
					if !ok || object[part] == nil {
						t.Errorf("unresolved reference: %s", ref)
						return
					}
					target = object[part]
				}
			}
			for _, child := range value {
				visit(child)
			}
		case []any:
			for _, child := range value {
				visit(child)
			}
		}
	}
	visit(document)
}

// wireModels maps schema names to the Go types that encode or decode them.
var wireModels = map[string]any{
	"SaveNote": saveRequest{}, "SaveEncryptedNote": vaultSaveRequest{},
	"MigrationStart": vaultMigrationStart{}, "VaultReset": vaultResetRequest{},
	"CredentialChange": vaultCredentialRequest{}, "StagedRequest": vaultStagedRequest{},
	"Operation": notesync.Operation{}, "EncryptedOperation": vaultSyncOperation{},
	"PushRequest": notesync.PushRequest{}, "EncryptedPushRequest": vaultSyncPushRequest{},
	"PushResult": notesync.PushResponse{}, "Acknowledgement": notesync.OperationResult{},
	"Change": notesync.Change{}, "ChangesPage": notesync.ChangesPage{},
	"Preferences": preference.Preferences{}, "ShortcutBinding": preference.ShortcutBinding{},
	"ShortcutStep": preference.ShortcutStep{}, "PlainNote": note{},
	"AIConfiguration": ai.Configuration{}, "AISession": ai.Session{}, "AIHunk": ai.Hunk{},
	"AIJob": ai.Job{}, "AIPlan": ai.Plan{},
}

func TestAPIReferenceWireFields(t *testing.T) {
	schemas := apiReference(t)["components"].(map[string]any)["schemas"].(map[string]any)
	var fields func(map[string]any) map[string]bool
	fields = func(schema map[string]any) map[string]bool {
		result := map[string]bool{}
		if ref, ok := schema["$ref"].(string); ok {
			return fields(schemas[strings.TrimPrefix(ref, "#/components/schemas/")].(map[string]any))
		}
		if properties, ok := schema["properties"].(map[string]any); ok {
			for name := range properties {
				result[name] = true
			}
		}
		if parts, ok := schema["allOf"].([]any); ok {
			for _, part := range parts {
				for name := range fields(part.(map[string]any)) {
					result[name] = true
				}
			}
		}
		return result
	}
	for name, model := range wireModels {
		t.Run(name, func(t *testing.T) {
			documented := fields(schemas[name].(map[string]any))
			typeOf := reflect.TypeOf(model)
			for i := 0; i < typeOf.NumField(); i++ {
				field := strings.Split(typeOf.Field(i).Tag.Get("json"), ",")[0]
				if field == "" || field == "-" {
					continue
				}
				if !documented[field] {
					t.Errorf("wire field %q missing from schema", field)
				}
				delete(documented, field)
			}
			for field := range documented {
				t.Errorf("schema field %q is not in wire model", field)
			}
		})
	}
}

func operations(document map[string]any) map[string]map[string]any {
	result := map[string]map[string]any{}
	for path, item := range document["paths"].(map[string]any) {
		for method, value := range item.(map[string]any) {
			result[strings.ToUpper(method)+" "+path] = value.(map[string]any)
		}
	}
	return result
}

// TestAPIReferenceExamples requires an example for every request body and
// success response, and one example per error code.
func TestAPIReferenceExamples(t *testing.T) {
	for pattern, operation := range operations(apiReference(t)) {
		if body, ok := operation["requestBody"].(map[string]any); ok {
			media := body["content"].(map[string]any)["application/json"].(map[string]any)
			if media["example"] == nil {
				t.Errorf("%s: request body has no example", pattern)
			}
		}
		for status, value := range operation["responses"].(map[string]any) {
			content, ok := value.(map[string]any)["content"].(map[string]any)
			if !ok {
				continue
			}
			for mediaType, media := range content {
				media := media.(map[string]any)
				if strings.HasPrefix(status, "2") || mediaType != "application/json" {
					if media["example"] == nil {
						t.Errorf("%s %s: response has no example", pattern, status)
					}
					continue
				}
				examples, _ := media["examples"].(map[string]any)
				if len(examples) == 0 {
					t.Errorf("%s %s: error response has no examples", pattern, status)
				}
				for name, example := range examples {
					value := example.(map[string]any)["value"].(map[string]any)
					if code, _ := value["code"].(string); code != name && value["expected_sequence"] == nil {
						t.Errorf("%s %s: example %q has code %q", pattern, status, name, code)
					}
					if example.(map[string]any)["summary"] == nil {
						t.Errorf("%s %s: example %q has no summary", pattern, status, name)
					}
				}
			}
		}
	}
}

// TestAPIReferenceErrorCodes fails when the reference documents an error code
// that no server source file contains.
func TestAPIReferenceErrorCodes(t *testing.T) {
	var source strings.Builder
	for _, pattern := range []string{"*.go", "../*/*.go"} {
		files, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			source.Write(data)
		}
	}
	for pattern, operation := range operations(apiReference(t)) {
		for status, value := range operation["responses"].(map[string]any) {
			content, _ := value.(map[string]any)["content"].(map[string]any)
			media, _ := content["application/json"].(map[string]any)
			examples, _ := media["examples"].(map[string]any)
			for _, example := range examples {
				code, _ := example.(map[string]any)["value"].(map[string]any)["code"].(string)
				if code != "" && !strings.Contains(source.String(), strconv.Quote(code)) {
					t.Errorf("%s %s: code %q is not in the server source", pattern, status, code)
				}
			}
		}
	}
}

// TestAPIReferenceRequestExamples decodes each request example into the Go
// type that the handler decodes, rejecting unknown fields as the server does.
func TestAPIReferenceRequestExamples(t *testing.T) {
	for pattern, operation := range operations(apiReference(t)) {
		body, ok := operation["requestBody"].(map[string]any)
		if !ok {
			continue
		}
		media := body["content"].(map[string]any)["application/json"].(map[string]any)
		schema := media["schema"].(map[string]any)
		candidates := []any{schema}
		for _, key := range []string{"oneOf", "anyOf"} {
			if variants, ok := schema[key].([]any); ok {
				candidates = variants
			}
		}
		example, err := json.Marshal(media["example"])
		if err != nil {
			t.Fatal(err)
		}
		checked, decoded := false, false
		for _, candidate := range candidates {
			ref, _ := candidate.(map[string]any)["$ref"].(string)
			model, ok := wireModels[strings.TrimPrefix(ref, "#/components/schemas/")]
			if !ok {
				continue
			}
			checked = true
			decoder := json.NewDecoder(bytes.NewReader(example))
			decoder.DisallowUnknownFields()
			if decoder.Decode(reflect.New(reflect.TypeOf(model)).Interface()) == nil {
				decoded = true
			}
		}
		if checked && !decoded {
			t.Errorf("%s: request example does not decode into its wire model", pattern)
		}
	}
}
