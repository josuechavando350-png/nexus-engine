package core

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

type SuiteDispatchReceipt struct {
	Suite     string         `json:"suite"`
	SiteID    string         `json:"site_id"`
	Enabled   bool           `json:"enabled"`
	Bypassed  bool           `json:"bypassed"`
	Submitted int            `json:"submitted"`
	JobIDs    map[int]string `json:"job_ids,omitempty"`
	States    map[int]string `json:"states,omitempty"`
}

type ModuleEvidence struct {
	ModuleID       int             `json:"module_id"`
	ModuleKey      string          `json:"module_key"`
	State          string          `json:"state"`
	Execution      string          `json:"execution"`
	SourceRevision string          `json:"source_revision"`
	InputHash      string          `json:"input_hash"`
	EvidenceHash   string          `json:"evidence_hash"`
	Payload        json.RawMessage `json:"payload,omitempty"`
}

// DispatchSuite200 fans out all 200 contracts to the background queue. GATED
// and ADVISORY modules still emit evidence jobs, but the handler must not turn a
// gated contract into an external or destructive action. Disabled tenants are
// returned before the catalog or queue is touched.
func DispatchSuite200(
	ctx context.Context,
	q *MemoryQueue,
	siteID string,
	enabled bool,
	sourceRevision string,
	inputHash string,
	payload json.RawMessage,
) (SuiteDispatchReceipt, error) {
	if !enabled {
		return SuiteDispatchReceipt{Suite: "SEO_AVENGERS_200", SiteID: siteID, Enabled: false, Bypassed: true}, nil
	}
	if q == nil {
		return SuiteDispatchReceipt{}, fmt.Errorf("queue is required")
	}
	if sourceRevision == "" || inputHash == "" {
		return SuiteDispatchReceipt{}, fmt.Errorf("source_revision and input_hash are required")
	}
	plan, err := ActivationPlan(siteID, true)
	if err != nil {
		return SuiteDispatchReceipt{}, err
	}
	receipt := SuiteDispatchReceipt{
		Suite: "SEO_AVENGERS_200", SiteID: siteID, Enabled: true,
		Bypassed: false, JobIDs: make(map[int]string, SeoAvengersModuleCount),
		States: make(map[int]string, SeoAvengersModuleCount),
	}
	for _, module := range plan.Modules {
		modulePayload, err := json.Marshal(map[string]any{
			"site_id":    siteID,
			"module_id":  module.ID,
			"module_key": module.Key,
			"state":      module.State,
			"execution":  module.Execution,
			"input":      json.RawMessage(payload),
		})
		if err != nil {
			return SuiteDispatchReceipt{}, err
		}
		jobID, _, err := q.Submit(ctx, JobEnvelope{
			ModuleID: module.ID, SourceRevision: sourceRevision,
			InputHash: inputHash, IdempotencyKey: inputHash,
			Payload: modulePayload,
		})
		if err != nil {
			return SuiteDispatchReceipt{}, err
		}
		receipt.JobIDs[module.ID] = jobID
		receipt.States[module.ID] = module.State
		receipt.Submitted++
	}
	return receipt, nil
}

// ContractEvidenceHandler is a deterministic evidence boundary used by the
// Commander/local mirror. Real provider-specific work remains in its declared
// async service; this handler proves the fan-out contract without blocking the
// Nexus renderer.
func ContractEvidenceHandler(ctx context.Context, job JobEnvelope) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	catalog, err := ModuleCatalog()
	if err != nil {
		return nil, err
	}
	if job.ModuleID < 1 || job.ModuleID > len(catalog) {
		return nil, fmt.Errorf("unsupported background module %d", job.ModuleID)
	}
	module := catalog[job.ModuleID-1]
	var in map[string]any
	if len(job.Payload) > 0 {
		if err := json.Unmarshal(job.Payload, &in); err != nil {
			return nil, err
		}
	}
	state, _ := in["state"].(string)
	payload := map[string]any{
		"module_id":             module.ID,
		"module_key":            module.Key,
		"execution":             module.Execution,
		"state":                 state,
		"source_revision":       job.SourceRevision,
		"input_hash":            job.InputHash,
		"request_path_blocking": false,
	}
	// Keep map order deterministic by hashing through an ordered projection.
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make([][2]any, 0, len(keys))
	for _, k := range keys {
		ordered = append(ordered, [2]any{k, payload[k]})
	}
	hash, err := CanonicalDigest(ordered)
	if err != nil {
		return nil, err
	}
	payload["evidence_hash"] = hash
	return json.Marshal(payload)
}
