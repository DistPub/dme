// Package config holds runtime configuration for the DME AppView server.
package config

import (
	"flag"
	"fmt"
	"time"
)

// Config is the resolved configuration for a DME AppView instance.
type Config struct {
	// Addr is the HTTP listen address for the query API.
	Addr string

	// DBPath is the filesystem path to the BadgerDB data directory.
	DBPath string

	// JetstreamURL is the WebSocket base URL of Bluesky Jetstream,
	// e.g. "wss://jetstream1.us-east.bsky.network".
	JetstreamURL string

	// EnvelopeTTL is how long an envelope remains queryable before it is
	// physically expired by BadgerDB.
	EnvelopeTTL time.Duration
}

// Default returns a Config populated with production defaults.
func Default() Config {
	return Config{
		Addr:         ":8080",
		DBPath:       "./dme.db",
		JetstreamURL: "wss://jetstream1.us-east.bsky.network",
		EnvelopeTTL:  7 * 24 * time.Hour,
	}
}

// FromFlags parses command-line flags and returns a Config.
func FromFlags() Config {
	c := Default()
	flag.StringVar(&c.Addr, "addr", c.Addr, "HTTP listen address")
	flag.StringVar(&c.DBPath, "db", c.DBPath, "BadgerDB data directory")
	flag.StringVar(&c.JetstreamURL, "jetstream", c.JetstreamURL, "Bluesky Jetstream WebSocket base URL")
	var showVersion bool
	flag.BoolVar(&showVersion, "version", false, "Show version and exit")
	flag.Parse()
	if showVersion {
		// version printed by main after parsing
	}
	return c
}

// String returns a human-readable summary for startup logging.
func (c Config) String() string {
	return fmt.Sprintf("addr=%s db=%s jetstream=%s ttl=%s",
		c.Addr, c.DBPath, c.JetstreamURL, c.EnvelopeTTL)
}
