// DME AppView - consumes dme.queue.envelope events from Bluesky Jetstream,
// stores them in BadgerDB with a 7-day TTL, and exposes a batch query
// endpoint for OHTTP polling.
//
// This server does NOT accept createRecord (records are written to the
// user's Bluesky PDS) and does NOT produce events (only consumes).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"dme/dme-server/internal/config"
	"dme/dme-server/internal/jetstream"
	"dme/dme-server/internal/server"
)

var version = "dev"

func main() {
	cfg := config.FromFlags()

	if flag.Lookup("version").Value.String() == "true" {
		fmt.Printf("dme-server %s\n", version)
		os.Exit(0)
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(log)

	srv, err := server.New(cfg.DBPath)
	if err != nil {
		log.Error("failed to init server", "err", err)
		os.Exit(1)
	}
	defer srv.Close()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Start Jetstream consumer in background.
	consumer := jetstream.New(cfg.JetstreamURL, srv.Store(), log)
	go func() {
		if err := consumer.Start(ctx); err != nil {
			log.Error("jetstream consumer stopped", "err", err)
		}
	}()

	httpServer := &http.Server{
		Addr:         cfg.Addr,
		Handler:      srv.Handler(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		log.Info("DME AppView listening", "config", cfg.String())
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received")
	case err := <-serverErr:
		log.Error("HTTP server error", "err", err)
		cancel()
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Error("HTTP server shutdown error", "err", err)
	}

	log.Info("DME AppView stopped")
}
