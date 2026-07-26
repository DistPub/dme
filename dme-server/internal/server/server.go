// Package server wires the HTTP handler for the DME AppView.
//
// One endpoint:
//   POST /xrpc/dme.batch.get  - batch blind retrieval for OHTTP polling
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"dme/dme-server/internal/store"
)

// Server holds the store and HTTP handler.
type Server struct {
	store *store.Store
	log   *slog.Logger
}

// New creates a Server with a BadgerDB-backed store.
func New(dbPath string) (*Server, error) {
	st, err := store.New(dbPath, nil)
	if err != nil {
		return nil, err
	}
	return &Server{store: st, log: slog.Default()}, nil
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/_health", s.handleHealth)
	mux.HandleFunc("/xrpc/dme.batch.get", s.handleBatchGet)
	return withCORS(mux)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Store returns the underlying store, used by the jetstream consumer.
func (s *Server) Store() *store.Store {
	return s.store
}

// Close shuts down the store.
func (s *Server) Close() error {
	return s.store.Close()
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok"}); err != nil {
		s.log.Error("health: failed to encode response", "err", err)
	}
}

type batchGetReq struct {
	QueueIDs []string `json:"queueIds"`
}

func (s *Server) handleBatchGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req batchGetReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		if encErr := json.NewEncoder(w).Encode(map[string]string{
			"error":   "InvalidRequest",
			"message": err.Error(),
		}); encErr != nil {
			s.log.Error("batchGet: failed to encode error response", "err", encErr)
		}
		return
	}

	envelopes, err := s.store.GetBatch(r.Context(), req.QueueIDs)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		if encErr := json.NewEncoder(w).Encode(map[string]string{
			"error":   "StoreError",
			"message": err.Error(),
		}); encErr != nil {
			s.log.Error("batchGet: failed to encode error response", "err", encErr)
		}
		return
	}
	if envelopes == nil {
		envelopes = []store.Envelope{}
	}

	if err := json.NewEncoder(w).Encode(map[string]any{
		"envelopes": envelopes,
	}); err != nil {
		s.log.Error("batchGet: failed to encode response", "err", err)
	}
}
