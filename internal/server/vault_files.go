package server

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	notepkg "vylk/internal/note"
)

func (a *app) vaultGenerationDir(epoch int64) string {
	return filepath.Join(a.notesDir, ".vylk-vault", fmt.Sprintf("epoch-%d", epoch))
}

func (a *app) vaultFilename(id string, epoch int64) string {
	return filepath.Join(".vylk-vault", fmt.Sprintf("epoch-%d", epoch), id+".md.enc")
}

func (a *app) ensureVaultGeneration(epoch int64) (string, error) {
	parent := filepath.Join(a.notesDir, ".vylk-vault")
	if info, err := os.Lstat(parent); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", errors.New("vault storage directory is invalid")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	directory := a.vaultGenerationDir(epoch)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("vault generation directory is invalid")
	}
	return directory, nil
}

func copyPrivateTree(source, destination string) error {
	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("cannot back up symlink %q", relative)
		}
		// A retry can already have staged ciphertext. The backup needs the
		// legacy source files, not another copy of generated vault files.
		if relative == ".vylk-vault" {
			if !entry.IsDir() {
				return errors.New("vault storage path is not a directory")
			}
			return filepath.SkipDir
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.Mkdir(target, 0700)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("cannot back up non-regular file %q", relative)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			input.Close()
			return err
		}
		if _, err = io.CopyBuffer(output, input, make([]byte, 32<<10)); err != nil {
			input.Close()
			output.Close()
			return err
		}
		if err = input.Close(); err != nil {
			output.Close()
			return err
		}
		if err = output.Sync(); err != nil {
			output.Close()
			return err
		}
		return output.Close()
	})
}

func (a *app) checkLegacyNoteFiles() error {
	rows, err := a.db.Query("SELECT id, filename FROM notes")
	if err != nil {
		return err
	}
	expected := make(map[string]bool)
	for rows.Next() {
		var id, filename string
		if err := rows.Scan(&id, &filename); err != nil {
			rows.Close()
			return err
		}
		if filename != id+".md" {
			rows.Close()
			return fmt.Errorf("unexpected legacy note path %q", filename)
		}
		expected[filename] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	entries, err := os.ReadDir(a.notesDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == ".vylk-vault" {
			if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				return errors.New("vault storage directory is invalid")
			}
			continue
		}
		if name == ".vylk-crypto.json" && entry.Type().IsRegular() {
			continue
		}
		if !expected[name] || !entry.Type().IsRegular() {
			return fmt.Errorf("unexpected file in notes directory: %q", name)
		}
		delete(expected, name)
	}
	for name := range expected {
		return fmt.Errorf("legacy note file is missing: %q", name)
	}
	return nil
}

func (a *app) createVaultBackup(directory string) error {
	if !strings.HasPrefix(filepath.Base(directory), ".vylk-migration-backup-") ||
		filepath.Clean(filepath.Dir(directory)) != filepath.Clean(filepath.Dir(a.notesDir)) {
		return errors.New("invalid migration backup path")
	}
	if err := os.RemoveAll(filepath.Join(directory, "notes")); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(directory, "vault.db")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := a.db.Exec("VACUUM INTO ?", filepath.Join(directory, "vault.db")); err != nil {
		return fmt.Errorf("create consistent database copy: %w", err)
	}
	if err := os.Chmod(filepath.Join(directory, "vault.db"), 0600); err != nil {
		return err
	}
	if err := copyPrivateTree(a.notesDir, filepath.Join(directory, "notes")); err != nil {
		return fmt.Errorf("copy notes directory: %w", err)
	}
	return notepkg.SyncDirectory(directory)
}
