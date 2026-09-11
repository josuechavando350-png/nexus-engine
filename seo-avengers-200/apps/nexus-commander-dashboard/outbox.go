package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const sectionAuthority = "NEXUS_SEO_AVENGERS_200_SECTION_V1"
const maxOutboxBytes int64 = 1 << 20

type sectionEnvelope struct {
	Authority       string  `json:"authority"`
	SchemaVersion   int     `json:"schema_version"`
	SiteID          string  `json:"site_id"`
	Route           string  `json:"route"`
	SectionID       string  `json:"section_id"`
	Locale          string  `json:"locale"`
	CanonicalOrigin *string `json:"canonical_origin"`
	Text            string  `json:"text"`
	Keyword         *string `json:"keyword"`
	SourceRevision  string  `json:"source_revision"`
	InputHash       string  `json:"input_hash"`
	IdempotencyKey  string  `json:"idempotency_key"`
}

func validateSectionEnvelope(raw []byte) error {
	var value sectionEnvelope
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("decode outbox envelope: %w", err)
	}
	if value.Authority != sectionAuthority || value.SchemaVersion != 2 {
		return fmt.Errorf("unsupported section envelope authority/version")
	}
	if value.SiteID == "" || value.Route == "" || value.SectionID == "" || value.Locale == "" || value.Text == "" || value.SourceRevision == "" {
		return fmt.Errorf("section envelope is incomplete")
	}
	if !strings.HasPrefix(value.InputHash, "sha256:") || len(value.InputHash) != 71 || value.IdempotencyKey != value.InputHash {
		return fmt.Errorf("section envelope hash/idempotency binding is invalid")
	}
	return nil
}

func (s *server) processSeoOutboxOnce(ctx context.Context, outboxDir string) (int, error) {
	entries, err := os.ReadDir(outboxDir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	processedDir := filepath.Join(filepath.Dir(outboxDir), "processed")
	if err := os.MkdirAll(processedDir, 0o750); err != nil {
		return 0, err
	}

	processed := 0
	for _, entry := range entries {
		if ctx.Err() != nil {
			return processed, ctx.Err()
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(outboxDir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > maxOutboxBytes {
			log.Printf("seo-avengers outbox rejected %s", entry.Name())
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if err := validateSectionEnvelope(raw); err != nil {
			log.Printf("seo-avengers outbox invalid %s: %v", entry.Name(), err)
			continue
		}
		if _, rpcErr := s.semanticPOST(ctx, "/v1/semantic/sections", raw); rpcErr != nil {
			// Leave the durable file in place. A later poll retries it.
			log.Printf("seo-avengers semantic enqueue failed for %s: %s", entry.Name(), rpcErr.Message)
			continue
		}
		if err := os.Rename(path, filepath.Join(processedDir, entry.Name())); err != nil {
			return processed, fmt.Errorf("archive outbox envelope: %w", err)
		}
		processed++
	}
	return processed, nil
}

func (s *server) startSeoOutbox(ctx context.Context, outboxDir string, poll time.Duration) {
	if strings.TrimSpace(outboxDir) == "" {
		return
	}
	if poll <= 0 {
		poll = 250 * time.Millisecond
	}
	go func() {
		ticker := time.NewTicker(poll)
		defer ticker.Stop()
		for {
			if _, err := s.processSeoOutboxOnce(ctx, outboxDir); err != nil && ctx.Err() == nil {
				log.Printf("seo-avengers outbox poll failed: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
