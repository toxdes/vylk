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
	vaultConfig, err := store.GetVaultConfig(db)
	if err != nil {
		log.Fatalf("vault config: %v", err)
	}
	if err := validateRuntimeCredentials(config, vaultConfig); err != nil {
		log.Fatal(err)
	}

	sessions := auth.NewSessionStore(db)

	rl, err := auth.NewRateLimiter(db, config.TrustProxy)
	if err != nil {
		log.Fatalf("rate limiter: %v", err)
	}

	if vaultConfig == nil || vaultConfig.Mode == store.VaultPreparing {
		if err := validatePlaintextStorage(notesDir); err != nil {
			log.Fatalf("notes storage: %v", err)
		}
	}

	app := &app{
		db:                     db,
		instanceID:             instanceID,
		sessions:               sessions,
		password:               config.Password,
		requireStrongPasswords: config.RequireStrongPasswords,
		disableVaultChanges:    config.DisableVaultChanges,
		notesDir:               notesDir,
		noteCache:              notepkg.NewCache(),
		rl:                     rl,
		events:                 event.NewBroker(),
	}
	if err := app.recoverFileOperations(); err != nil {
		log.Fatalf("recover pending file operations: %v", err)
	}
	if err := app.resumeVaultCleanup(); err != nil {
		log.Fatalf("resume encrypted vault cleanup: %v", err)
	}
	if err := app.recoverVaultFileOperations(); err != nil {
		log.Fatalf("recover encrypted file operations: %v", err)
	}
	if err := app.cleanupVaultArchives(time.Now().UTC()); err != nil {
		log.Printf("clean expired vault archives: %v", err)
	}

	go sessions.CleanupLoop()
	go app.vaultArchiveCleanupLoop()

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
