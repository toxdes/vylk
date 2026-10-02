package server

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

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
	models := map[string]any{
		"SaveNote": saveRequest{}, "SaveEncryptedNote": vaultSaveRequest{},
		"MigrationStart": vaultMigrationStart{}, "VaultReset": vaultResetRequest{},
		"CredentialChange": vaultCredentialRequest{}, "StagedRequest": vaultStagedRequest{},
		"Operation": notesync.Operation{}, "EncryptedOperation": vaultSyncOperation{},
		"PushRequest": notesync.PushRequest{}, "EncryptedPushRequest": vaultSyncPushRequest{},
		"PushResult": notesync.PushResponse{}, "Acknowledgement": notesync.OperationResult{},
		"Change": notesync.Change{}, "ChangesPage": notesync.ChangesPage{},
		"Preferences": preference.Preferences{}, "ShortcutBinding": preference.ShortcutBinding{},
		"ShortcutStep": preference.ShortcutStep{}, "PlainNote": note{},
	}
	for name, model := range models {
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
