package server

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"vylk/internal/auth"
	"vylk/internal/event"
	notepkg "vylk/internal/note"
	"vylk/internal/notecrypt"
	"vylk/internal/store"
	"vylk/internal/web"
)

var version = "dev"

var appRevision = web.Revision(web.DefaultName)

// Main runs the Vylk server process. Process-level exit handling remains in
// this package so startup and shutdown behavior can be characterized without
// coupling the implementation to the executable package.
func Main() {
	for _, a := range os.Args[1:] {
		if a == "-v" || a == "--version" || a == "-version" {
			fmt.Println(version)
			return
		}
	}

	config, err := loadRuntimeConfig(os.Args[1:], os.Getenv, readSecret)
	if err != nil {
		log.Fatal(err)
	}
	assets, err := web.New(config.AppName)
	if err != nil {
		log.Fatalf("web assets: %v", err)
	}
	appRevision = assets.Revision()
	notesDir, err := filepath.Abs(config.NotesDir)
	if err != nil {
		log.Fatalf("invalid notes directory: %v", err)
	}
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		log.Fatalf("cannot create notes directory: %v", err)
	}

	db, err := store.OpenDB(config.DatabasePath)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	if err := store.InitDB(db, config.DatabasePath); err != nil {
		log.Fatalf("init db: %v", err)
	}
	instanceID, err := store.InstanceID(db)
	if err != nil {
		log.Fatalf("read instance identity: %v", err)
	}

	sessions := auth.NewSessionStore(db)

	rl, err := auth.NewRateLimiter(db, config.TrustProxy)
	if err != nil {
		log.Fatalf("rate limiter: %v", err)
	}

	encryption, err := notecrypt.New(notesDir, config.EncryptionPassword, config.EncryptionKey)
	if err != nil {
		log.Fatalf("encryption: %v", err)
	}
	if encryption != nil {
		if encryption.LegacyWrite() {
			log.Println("legacy file encryption enabled; migrate to VYLK_ENCRYPTION_PASSWORD or an explicitly encoded 32-byte key")
		} else {
			log.Println("versioned file encryption enabled")
		}
	}

	app := &app{
		db:         db,
		instanceID: instanceID,
		sessions:   sessions,
		password:   config.Password,
		notesDir:   notesDir,
		encryption: encryption,
		noteCache:  notepkg.NewCache(),
		rl:         rl,
		events:     event.NewBroker(),
	}
	if err := app.recoverFileOperations(); err != nil {
		log.Fatalf("recover pending file operations: %v", err)
	}
	if config.MigrateEncryption {
		count, err := migrateEncryption(app)
		if err != nil {
			log.Fatalf("encryption migration: %v", err)
		}
		log.Printf("migrated %d note files to encryption v2", count)
	}

	go sessions.CleanupLoop()

	if config.ArtificialDelay > 0 {
		log.Printf("artificial request delay enabled: %s per request", config.ArtificialDelay)
	}

	srv := &http.Server{
		Addr:         ":" + config.Port,
		Handler:      newHandler(app, assets, config.ArtificialDelay),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	listener, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		log.Fatalf("server: %v", err)
	}
	actualPort := listener.Addr().(*net.TCPAddr).Port
	serverURL := "http://127.0.0.1:" + strconv.Itoa(actualPort) + "/"
	go func() {
		err := srv.Serve(listener)
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()
	log.Printf("vylk running on :%d (notes: %s, db: %s)", actualPort, notesDir, config.DatabasePath)
	if config.OpenBrowser {
		if err := openBrowser(serverURL); err != nil {
			log.Printf("could not open browser at %s: %v", serverURL, err)
		}
	}

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}

func migrateEncryption(a *app) (int, error) {
	if a.encryption == nil || a.encryption.LegacyWrite() {
		return 0, fmt.Errorf("VYLK_MIGRATE_ENCRYPTION requires VYLK_ENCRYPTION_PASSWORD or an explicitly encoded key")
	}
	notes, err := store.ListNotes(a.db, "")
	if err != nil {
		return 0, err
	}
	count := 0
	for _, n := range notes {
		path, err := notepkg.SanitizePath(a.notesDir, n.Filename)
		if err != nil {
			return count, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return count, err
		}
		if notecrypt.IsVersionedEnvelope(data) {
			continue
		}
		plain, err := a.encryption.Decrypt(data, n.ID)
		if err != nil {
			return count, fmt.Errorf("decrypt %s: %w", n.ID, err)
		}
		updated, err := a.encryption.Encrypt(plain, n.ID)
		if err != nil {
			return count, err
		}
		if err := notepkg.WriteFile(path, updated); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
