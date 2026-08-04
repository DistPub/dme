// Package store provides a BadgerDB-backed key-value store for DME envelopes.
//
// Envelopes are stored by queueId with a native BadgerDB TTL (7 days).
// Expired entries are garbage-collected automatically by BadgerDB's
// value-log GC — no manual sweeper goroutine is needed.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/dgraph-io/badger/v4"
)

// EnvelopeTTL is 7 days, matching the DME protocol spec.
const EnvelopeTTL = 7 * 24 * time.Hour

// valueLogFileSize controls the maximum size of a single BadgerDB value log
// file. 64 MiB keeps GC churn reasonable for envelope-sized values
// (1–100 KB ciphertext).
const valueLogFileSize = 64 << 20

// gcThreshold is the discard ratio passed to RunValueLogGC. 0.5 means GC
// runs once half of a value log file is stale/expired.
const gcThreshold = 0.5

// gcInterval controls how often the background GC goroutine wakes.
const gcInterval = 10 * time.Minute

// Envelope is the Go mirror of the dme.queue.envelope Lexicon record.
type Envelope struct {
	QueueID      string    `json:"queueId"`
	Payload      string    `json:"payload"`
	CreatedAt    time.Time `json:"createdAt"`
	RatchetEpoch int       `json:"ratchetEpoch,omitempty"`
	BlobCids     []string  `json:"blobCids,omitempty"`
}

// Store wraps BadgerDB for envelope persistence with native TTL.
type Store struct {
	db  *badger.DB
	log *slog.Logger
}

// New opens (or creates) a BadgerDB database at the given path.
//
// The database is configured for envelope workloads: a 64 MiB value log
// file size and native TTL expiry. A background goroutine is started to
// periodically run value-log garbage collection.
func New(path string, log *slog.Logger) (*Store, error) {
	if log == nil {
		log = slog.Default()
	}

	opts := badger.DefaultOptions(path).
		WithValueLogFileSize(valueLogFileSize).
		WithLogger(badgerLogger{log: log.With("component", "badger")})

	db, err := badger.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("open badger: %w", err)
	}

	s := &Store{db: db, log: log}

	// Background value-log GC. BadgerDB natively expires TTL entries at
	// read time, but stale value-log pages must be reclaimed by RunValueLogGC
	// to keep disk usage bounded.
	go s.gcLoop()

	return s, nil
}

// Put stores an envelope keyed by queueId with the 7-day TTL.
func (s *Store) Put(ctx context.Context, env Envelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	return s.db.Update(func(txn *badger.Txn) error {
		entry := badger.NewEntry([]byte(env.QueueID), data).WithTTL(EnvelopeTTL)
		return txn.SetEntry(entry)
	})
}

// Get retrieves an envelope by queueId. Returns ErrNotFound if absent or
// expired (BadgerDB returns ErrKeyNotFound for TTL-expired keys).
func (s *Store) Get(ctx context.Context, queueId string) (*Envelope, error) {
	var env Envelope
	err := s.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get([]byte(queueId))
		if err != nil {
			return err
		}
		return item.Value(func(val []byte) error {
			return json.Unmarshal(val, &env)
		})
	})
	if err != nil {
		if err == badger.ErrKeyNotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &env, nil
}

// GetBatch retrieves multiple envelopes by queueId in a single read
// transaction. Envelopes that are absent or expired are silently skipped.
func (s *Store) GetBatch(ctx context.Context, queueIds []string) ([]Envelope, error) {
	var results []Envelope
	err := s.db.View(func(txn *badger.Txn) error {
		for _, qid := range queueIds {
			item, err := txn.Get([]byte(qid))
			if err != nil {
				if err == badger.ErrKeyNotFound {
					continue
				}
				return err
			}
			if err := item.Value(func(val []byte) error {
				var env Envelope
				if err := json.Unmarshal(val, &env); err != nil {
					s.log.Warn("failed to unmarshal envelope, skipping",
						"queueId", qid, "err", err)
					return nil
				}
				results = append(results, env)
				return nil
			}); err != nil {
				return err
			}
		}
		return nil
	})
	return results, err
}

// Delete removes an envelope by queueId.
func (s *Store) Delete(ctx context.Context, queueId string) error {
	return s.db.Update(func(txn *badger.Txn) error {
		return txn.Delete([]byte(queueId))
	})
}

// Close closes the underlying database.
func (s *Store) Close() error {
	return s.db.Close()
}

// gcLoop periodically runs BadgerDB value-log garbage collection.
func (s *Store) gcLoop() {
	ticker := time.NewTicker(gcInterval)
	defer ticker.Stop()
	for range ticker.C {
		s.runGC()
	}
}

// runGC repeatedly calls RunValueLogGC until no file meets the discard
// threshold (returns nil), reclaiming space from expired/deleted entries.
func (s *Store) runGC() {
	for {
		err := s.db.RunValueLogGC(gcThreshold)
		if err != nil {
			if err != badger.ErrNoRewrite {
				s.log.Warn("value log GC error", "err", err)
			}
			return
		}
		s.log.Debug("value log GC reclaimed a file")
	}
}

// badgerLogger adapts slog to BadgerDB's Logger interface.
type badgerLogger struct {
	log *slog.Logger
}

func (l badgerLogger) Errorf(format string, v ...any) {
	l.log.Error(fmt.Sprintf(format, v...))
}

func (l badgerLogger) Warningf(format string, v ...any) {
	l.log.Warn(fmt.Sprintf(format, v...))
}

func (l badgerLogger) Infof(format string, v ...any) {
	l.log.Info(fmt.Sprintf(format, v...))
}

func (l badgerLogger) Debugf(format string, v ...any) {
	l.log.Debug(fmt.Sprintf(format, v...))
}
