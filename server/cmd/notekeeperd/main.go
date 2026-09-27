// Command notekeeperd is the Note Keeper backend: a loopback HTTP daemon that
// owns an Obsidian-compatible vault directory, keeps a live full-text/link
// index of it, runs OCR, and streams change events.
//
// It is normally spawned and supervised by the dsh-note-keeper host plugin:
//
//	NK_VAULT=~/NoteKeeper NK_SECRET=<random> notekeeperd -addr 127.0.0.1:0 -parent-stdin
//
// With -addr ...:0 the kernel picks a free port; the daemon prints exactly one
// line "NK_LISTEN <host:port>" on stdout once it is ready. With -parent-stdin
// it exits when its stdin closes, so it can never outlive the plugin.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/api"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/devsync"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/index"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/watch"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	addr := flag.String("addr", env("NK_ADDR", "127.0.0.1:0"), "listen address (loopback only)")
	vaultDir := flag.String("vault", env("NK_VAULT", "~/NoteKeeper"), "vault directory")
	parentStdin := flag.Bool("parent-stdin", false, "exit when stdin reaches EOF (supervised mode)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	if *parentStdin {
		log.SetFlags(log.Lmsgprefix) // the supervising host already timestamps lines
	}
	log.SetPrefix("notekeeperd: ")
	log.SetOutput(os.Stderr)

	host, _, err := net.SplitHostPort(*addr)
	if err != nil || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		log.Fatalf("refusing to listen on %q: loopback addresses only", *addr)
	}
	secret := os.Getenv("NK_SECRET")
	if len(secret) < 16 {
		log.Fatal("NK_SECRET must be set (>=16 chars); the host plugin generates it")
	}
	_ = os.Unsetenv("NK_SECRET") // keep it out of any child process (tesseract)

	v, err := vault.Open(expandHome(*vaultDir))
	if err != nil {
		log.Fatalf("open vault: %v", err)
	}
	ix := index.New()
	hub := watch.NewHub()
	w := watch.New(v, ix, hub)
	t0 := time.Now()
	w.Scan()
	st := ix.Stats()
	log.Printf("vault %s indexed: %d notes, %d attachments in %s", v.Root(), st.Notes, st.Attachments, time.Since(t0).Round(time.Millisecond))

	cfg := api.Config{
		Secret:       secret,
		Tesseract:    env("NK_TESSERACT", "tesseract"),
		DailyFolder:  env("NK_DAILY_FOLDER", "Daily"),
		InboxNote:    env("NK_INBOX", "Inbox.md"),
		AttachFolder: env("NK_ATTACH_FOLDER", "attachments"),
		TemplatesDir: env("NK_TEMPLATES", "Templates"),
		Version:      version,
	}
	// Remote device sync (Obsidian plugin, WebDAV, cloud mirror) on its own
	// loopback listener, reached from the internet only through a dedicated
	// edge route. A failure here never takes the local app down.
	var syncHS *http.Server
	var syncSvc *devsync.Service
	if saddr := os.Getenv("NK_SYNC_ADDR"); saddr != "" {
		if h, _, err := net.SplitHostPort(saddr); err != nil || (h != "127.0.0.1" && h != "::1") {
			log.Printf("sync disabled: NK_SYNC_ADDR must be a loopback address, got %q", saddr)
		} else if svc, err := devsync.New(devsync.Config{
			StateDir:   expandHome(env("NK_STATE", "~/.local/state/note-keeper")),
			PublicURL:  env("NK_SYNC_PUBLIC_URL", "https://llm.tzekos.eu/nk-sync"),
			IsEnvelope: func(b []byte) bool { return api.IsEnvelope(string(b)) },
			Touch:      w.Touch,
			Rclone:     env("NK_RCLONE", "rclone"),
		}, v); err != nil {
			log.Printf("sync disabled: %v", err)
		} else if sln, err := net.Listen("tcp", saddr); err != nil {
			log.Printf("sync disabled: listen %s: %v", saddr, err)
		} else {
			cfg.Sync, cfg.SyncListening, syncSvc = svc, sln.Addr().String(), svc
			events, _ := hub.Subscribe()
			go func() {
				for range events {
					svc.Invalidate()
				}
			}()
			syncHS = &http.Server{
				Handler:           svc.Handler(),
				ReadHeaderTimeout: 15 * time.Second,
				ReadTimeout:       15 * time.Minute, // large attachments over slow mobile links
				WriteTimeout:      15 * time.Minute,
				IdleTimeout:       120 * time.Second,
				MaxHeaderBytes:    32 << 10,
			}
			go func() {
				if err := syncHS.Serve(sln); err != nil && err != http.ErrServerClosed {
					log.Printf("sync listener stopped: %v", err)
				}
			}()
			log.Printf("sync listening on %s (public %s)", cfg.SyncListening, svc.Status("")["url"])
		}
	}
	srv := api.New(cfg, v, ix, w)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if *parentStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			log.Print("parent closed stdin; shutting down")
			stop()
		}()
	}
	if syncSvc != nil {
		syncSvc.StartCloud(ctx)
	}
	go func() {
		if err := w.Run(ctx); err != nil {
			log.Printf("watcher stopped: %v (periodic rescans only)", err)
		}
	}()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	hs := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	if cfg.SyncListening != "" {
		fmt.Printf("NK_SYNC_LISTEN %s\n", cfg.SyncListening)
	}
	fmt.Printf("NK_LISTEN %s\n", ln.Addr().String())
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
		if syncHS != nil {
			_ = syncHS.Shutdown(sctx)
		}
	}()
	if err := hs.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
