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

// Reject the removed format before recovering staged writes. This deliberately
// retains no key handling or decryption support.
func validatePlaintextStorage(directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == ".vylk-crypto.json" {
			return errors.New("server-side encryption metadata found; export the notes with the previous version before upgrading")
		}
		if entry.IsDir() || (!strings.HasSuffix(name, ".md") && !strings.HasPrefix(name, notepkg.StageFilePrefix)) {
			continue
		}
		file, err := os.Open(filepath.Join(directory, name))
		if err != nil {
			return err
		}
		var header [5]byte
		_, readErr := io.ReadFull(file, header[:])
		closeErr := file.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if string(header[:]) == "MDN2\x01" {
			return fmt.Errorf("server-encrypted file %q found; export the notes with the previous version before upgrading", name)
		}
	}
	return nil
}
