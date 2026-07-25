package store

import "errors"

// ErrNotFound is returned when no envelope exists for the given queueId.
var ErrNotFound = errors.New("envelope not found")
