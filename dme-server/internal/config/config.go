// Package config holds runtime configuration for the DME AppView server.
package config

import (
	"flag"
	"fmt"
	"os"
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
		Addr:         getEnv("DME_SERVER_ADDR", ":8080"),
		DBPath:       getEnv("DME_SERVER_DB_PATH", "./dme.db"),
		JetstreamURL: getEnv("DME_SERVER_JETSTREAM_URL", "wss://jetstream1.us-east.bsky.network"),
		EnvelopeTTL:  getEnvDuration("DME_SERVER_ENVELOPE_TTL", 7*24*time.Hour),
	}
}

// FromFlags parses command-line flags and returns a Config.
// Command-line flags take precedence over environment variables.
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

// getEnv returns the value of the environment variable or the default.
func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}

// getEnvDuration returns the value of the environment variable as a duration or the default.
func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return defaultValue
}

// String returns a human-readable summary for startup logging.
func (c Config) String() string {
	return fmt.Sprintf("addr=%s db=%s jetstream=%s ttl=%s",
		c.Addr, c.DBPath, c.JetstreamURL, c.EnvelopeTTL)
}
