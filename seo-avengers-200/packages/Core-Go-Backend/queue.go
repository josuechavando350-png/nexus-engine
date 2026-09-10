package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

type JobEnvelope struct {
	ID             string          `json:"id"`
	ModuleID       int             `json:"module_id"`
	SourceRevision string          `json:"source_revision"`
	InputHash      string          `json:"input_hash"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
	SubmittedAt    time.Time       `json:"submitted_at"`
}

type JobResult struct {
	JobID      string          `json:"job_id"`
	ModuleID   int             `json:"module_id"`
	OutputHash string          `json:"output_hash"`
	Payload    json.RawMessage `json:"payload"`
	FinishedAt time.Time       `json:"finished_at"`
	Err        string          `json:"error,omitempty"`
}

type JobHandler func(context.Context, JobEnvelope) (json.RawMessage, error)

var ErrQueueClosed = errors.New("job queue closed")

type MemoryQueue struct {
	jobs      chan JobEnvelope
	results   sync.Map
	seen      sync.Map
	stateMu   sync.RWMutex
	closed    bool
	closeOnce sync.Once
	wg        sync.WaitGroup
}

func NewMemoryQueue(capacity int) *MemoryQueue {
	if capacity < 1 {
		capacity = 128
	}
	return &MemoryQueue{jobs: make(chan JobEnvelope, capacity)}
}

func deterministicJobID(moduleID int, sourceRevision, idempotencyKey string, payload []byte) string {
	h := sha256.New()
	fmt.Fprintf(h, "%d\x00%s\x00%s\x00", moduleID, sourceRevision, idempotencyKey)
	_, _ = h.Write(payload)
	return hex.EncodeToString(h.Sum(nil))[:32]
}

func (q *MemoryQueue) Submit(ctx context.Context, job JobEnvelope) (string, bool, error) {
	if job.ModuleID < 1 || job.ModuleID > SeoAvengersModuleCount {
		return "", false, fmt.Errorf("module_id out of range")
	}
	if job.SourceRevision == "" || job.InputHash == "" || job.IdempotencyKey == "" {
		return "", false, fmt.Errorf("source_revision, input_hash and idempotency_key are required")
	}
	if job.ID == "" {
		job.ID = deterministicJobID(job.ModuleID, job.SourceRevision, job.IdempotencyKey, job.Payload)
	}

	q.stateMu.RLock()
	defer q.stateMu.RUnlock()
	if q.closed {
		return "", false, ErrQueueClosed
	}
	if _, loaded := q.seen.LoadOrStore(job.ID, struct{}{}); loaded {
		return job.ID, true, nil
	}
	job.SubmittedAt = time.Now().UTC()
	select {
	case <-ctx.Done():
		q.seen.Delete(job.ID)
		return "", false, ctx.Err()
	case q.jobs <- job:
		return job.ID, false, nil
	}
}

func (q *MemoryQueue) StartWorkers(parent context.Context, n int, handler JobHandler) {
	if n < 1 {
		n = 1
	}
	for i := 0; i < n; i++ {
		q.wg.Add(1)
		go func() {
			defer q.wg.Done()
			for {
				select {
				case <-parent.Done():
					return
				case job, ok := <-q.jobs:
					if !ok {
						return
					}
					p, err := handler(parent, job)
					result := JobResult{JobID: job.ID, ModuleID: job.ModuleID, Payload: p, FinishedAt: time.Now().UTC()}
					if err != nil {
						result.Err = err.Error()
					}
					result.OutputHash, _ = CanonicalDigest(result.Payload)
					q.results.Store(job.ID, result)
				}
			}
		}()
	}
}

func (q *MemoryQueue) Result(jobID string) (JobResult, bool) {
	v, ok := q.results.Load(jobID)
	if !ok {
		return JobResult{}, false
	}
	return v.(JobResult), true
}

func (q *MemoryQueue) Close() {
	q.closeOnce.Do(func() {
		q.stateMu.Lock()
		q.closed = true
		close(q.jobs)
		q.stateMu.Unlock()
		q.wg.Wait()
	})
}
