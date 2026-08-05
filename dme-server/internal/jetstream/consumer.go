// Package jetstream consumes dme.queue.envelope events from Bluesky Jetstream.
//
// Jetstream is a lightweight JSON event stream that filters by collection
// server-side. Unlike the raw firehose (CBOR + CAR), Jetstream delivers
// one JSON object per WebSocket text message, with the record already
// parsed as a JSON object - no CBOR decoding or CAR extraction needed.
//
// The consumer connects with wantedCollections=dme.queue.envelope so only
// DME envelope events are delivered. No cursor is used - on startup the
// consumer begins from the latest events.
package jetstream

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"github.com/coder/websocket"
	"dme/dme-server/internal/store"
)

// Storer is the minimal store interface the consumer needs.
type Storer interface {
	Put(ctx context.Context, env store.Envelope) error
}

// Consumer subscribes to Jetstream and persists DME envelopes.
type Consumer struct {
	jetstreamURL string
	store        Storer
	log          *slog.Logger
}

// jetstreamEvent is the top-level JSON message from Jetstream.
type jetstreamEvent struct {
	Kind   string  `json:"kind"`
	Did    string  `json:"did"`
	TimeUS int64   `json:"time_us"`
	Commit *commit `json:"commit,omitempty"`
}

// commit is the repo mutation inside a Jetstream event.
type commit struct {
	Rev        string          `json:"rev"`
	Operation  string          `json:"operation"`
	Collection string          `json:"collection"`
	Rkey       string          `json:"rkey"`
	Record     json.RawMessage `json:"record,omitempty"`
}

// envelopeRecord is the dme.queue.envelope record as JSON.
type envelopeRecord struct {
	QueueID      string `json:"queueId"`
	Payload      string `json:"payload"`
	CreatedAt    string `json:"createdAt"`
	RatchetEpoch int            `json:"ratchetEpoch,omitempty"`
	BlobCids     []store.BlobRef `json:"blobCids,omitempty"`
}

// New creates a Consumer for the given Jetstream URL.
func New(jetstreamURL string, st Storer, log *slog.Logger) *Consumer {
	if log == nil {
		log = slog.Default()
	}
	return &Consumer{
		jetstreamURL: jetstreamURL,
		store:        st,
		log:          log.With("component", "jetstream"),
	}
}

// Start connects to Jetstream and consumes events until ctx is cancelled.
// On error it reconnects with exponential backoff.
func (c *Consumer) Start(ctx context.Context) error {
	backoff := []time.Duration{
		5 * time.Second,
		10 * time.Second,
		20 * time.Second,
		40 * time.Second,
		60 * time.Second,
	}
	backoffIdx := 0

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		err := c.connectAndConsume(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		wait := backoff[backoffIdx]
		c.log.Warn("jetstream disconnected, reconnecting", "err", err, "backoff", wait)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}

		if backoffIdx < len(backoff)-1 {
			backoffIdx++
		}
	}
}

// connectAndConsume dials Jetstream, reads JSON events, stores DME envelopes.
func (c *Consumer) connectAndConsume(ctx context.Context) error {
	u := c.subscribeURL()
	c.log.Info("connecting to jetstream", "url", u)

	conn, _, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		return fmt.Errorf("dial jetstream: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Jetstream events can be large (record + metadata), allow up to 4 MiB.
	conn.SetReadLimit(4 << 20)

	c.log.Info("jetstream connected")

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		_, data, err := conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("read jetstream frame: %w", err)
		}

		c.processEvent(ctx, data)
	}
}

// processEvent parses a single Jetstream JSON event and stores the envelope
// if it's a dme.queue.envelope create.
func (c *Consumer) processEvent(ctx context.Context, data []byte) {
	var event jetstreamEvent
	if err := json.Unmarshal(data, &event); err != nil {
		c.log.Debug("skip event: invalid JSON", "err", err)
		return
	}

	if event.Kind != "commit" || event.Commit == nil {
		return
	}

	if event.Commit.Operation != "create" {
		return
	}

	if event.Commit.Collection != "dme.queue.envelope" {
		return
	}

	if len(event.Commit.Record) == 0 {
		return
	}

	var rec envelopeRecord
	if err := json.Unmarshal(event.Commit.Record, &rec); err != nil {
		c.log.Debug("skip event: invalid record JSON",
			"err", err, "did", event.Did, "rkey", event.Commit.Rkey)
		return
	}

	if rec.QueueID == "" {
		return
	}

	env := store.Envelope{
		QueueID:      rec.QueueID,
		Payload:      rec.Payload,
		CreatedAt:    parseTime(rec.CreatedAt),
		RatchetEpoch: rec.RatchetEpoch,
		BlobCids:     rec.BlobCids,
	}

	if err := c.store.Put(ctx, env); err != nil {
		c.log.Error("failed to store envelope",
			"queueId", env.QueueID, "did", event.Did, "err", err)
		return
	}

	c.log.Info("stored envelope",
		"queueId", env.QueueID, "did", event.Did)
}

// subscribeURL builds the Jetstream subscribe URL with wantedCollections filter.
func (c *Consumer) subscribeURL() string {
	u, err := url.Parse(c.jetstreamURL)
	if err != nil {
		return fmt.Sprintf("%s/subscribe?wantedCollections=dme.queue.envelope", c.jetstreamURL)
	}
	u.Path = "/subscribe"
	q := u.Query()
	q.Set("wantedCollections", "dme.queue.envelope")
	u.RawQuery = q.Encode()
	return u.String()
}

// parseTime parses an ISO 8601 timestamp, falling back to now on error.
func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Now().UTC()
	}
	return t
}
