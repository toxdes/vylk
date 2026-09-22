package note

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const StageFilePrefix = ".vylk-stage-"

func SanitizePath(base, path string) (string, error) {
	abs, err := filepath.Abs(filepath.Join(base, path))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", http.ErrMissingFile
	}
	return abs, nil
}

func WriteFile(path string, content []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".vylk-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func ContentHash(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}

func MatchesHash(path, expected string) (bool, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return ContentHash(content) == expected, nil
}

func SyncDirectory(directoryPath string) error {
	directory, err := os.Open(directoryPath)
	if err != nil {
		return err
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func RemoveAndSync(directory, name string) error {
	err := os.Remove(filepath.Join(directory, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return SyncDirectory(directory)
}

func StageFile(directory string, content []byte) (string, error) {
	tmp, err := os.CreateTemp(directory, StageFilePrefix+"*")
	if err != nil {
		return "", err
	}
	path := tmp.Name()
	remove := true
	defer func() {
		if remove {
			_ = RemoveAndSync(directory, filepath.Base(path))
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := SyncDirectory(directory); err != nil {
		return "", err
	}
	remove = false
	return filepath.Base(path), nil
}
