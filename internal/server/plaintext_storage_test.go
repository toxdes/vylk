package server

import (
	"os"
	"path/filepath"
	"testing"

	notepkg "vylk/internal/note"
)

func TestPlaintextStorageRejectsRemovedEncryptionWithoutChangingFiles(t *testing.T) {
	for _, fixture := range []struct {
		name string
		data []byte
	}{
		{".vylk-crypto.json", []byte(`{"version":1,"kdf":"argon2id"}`)},
		{"note.md", []byte("MDN2\x01old-ciphertext")},
		{".vylk-stage-test", []byte("MDN2\x01staged-ciphertext")},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, fixture.name)
			if err := os.WriteFile(path, fixture.data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := validatePlaintextStorage(dir); err == nil {
				t.Fatal("accepted removed server-side encryption")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != string(fixture.data) {
				t.Fatalf("file changed: %q, %v", got, err)
			}
		})
	}
}

func TestPlaintextStorageAcceptsMarkdown(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{"empty.md": "", "unicode.md": "# café ✓\n", "magic-text.md": "MDN2 is ordinary text", ".vylk-stage-test": "pending Markdown"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := validatePlaintextStorage(dir); err != nil {
		t.Fatal(err)
	}
}

func TestPlaintextNoteReadRejectsBinaryDataWithoutModifyingIt(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatal(err)
	}
	if err := upsertNote(db, "old-note", "Old", "old-note.md", ""); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "old-note.md")
	data := []byte{0xff, 0xfe, 0x00, 0x01}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	a := &app{db: db, notesDir: dir, noteCache: notepkg.NewCache()}
	if _, err := a.loadNoteWithContent("old-note"); err == nil {
		t.Fatal("accepted binary content as Markdown")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(data) {
		t.Fatalf("file changed: %q, %v", got, err)
	}
}
