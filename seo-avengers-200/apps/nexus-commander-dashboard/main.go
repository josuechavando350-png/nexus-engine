package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	core "github.com/nexusbotstudio/seo-avengers-200/core"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type pageRankParams struct {
	Routes         []string            `json:"routes"`
	Links          [][2]string         `json:"links"`
	Config         core.PageRankConfig `json:"config"`
	SourceRevision string              `json:"source_revision"`
	InputHash      string              `json:"input_hash"`
	IdempotencyKey string              `json:"idempotency_key"`
}

type jobGetParams struct {
	JobID string `json:"job_id"`
}

type activationParams struct {
	SiteID  string `json:"site_id"`
	Enabled bool   `json:"enabled"`
}

type suite200DispatchParams struct {
	SiteID         string          `json:"site_id"`
	Enabled        bool            `json:"enabled"`
	SourceRevision string          `json:"source_revision"`
	InputHash      string          `json:"input_hash"`
	Payload        json.RawMessage `json:"payload"`
}

type suite200StatusParams struct {
	JobIDs []string `json:"job_ids"`
}

type server struct {
	secret        string
	semanticURL   string
	semanticToken string
	queue         *core.MemoryQueue
	httpClient    *http.Client
}

func (s *server) authorized(r *http.Request) bool {
	if s.secret == "" {
		return true
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return len(got) == len(s.secret) && subtle.ConstantTimeCompare([]byte(got), []byte(s.secret)) == 1
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) rpc(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req rpcRequest
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, 400, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: -32700, Message: "parse error"}})
		return
	}
	if req.JSONRPC != "2.0" {
		writeJSON(w, 400, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32600, Message: "invalid request"}})
		return
	}
	result, rpcErr := s.dispatch(r.Context(), req.Method, req.Params)
	status := 200
	if rpcErr != nil {
		status = 400
	}
	writeJSON(w, status, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result, Error: rpcErr})
}

func (s *server) dispatch(ctx context.Context, method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "seo.health":
		return map[string]any{"ok": true, "time": time.Now().UTC()}, nil
	case "seo.modules.list":
		mods, err := core.ModuleCatalog()
		if err != nil {
			return nil, &rpcError{Code: -32603, Message: err.Error()}
		}
		return mods, nil
	case "seo.client.activation":
		var p activationParams
		if err := json.Unmarshal(params, &p); err != nil || p.SiteID == "" {
			return nil, &rpcError{Code: -32602, Message: "site_id and enabled are required"}
		}
		plan, err := core.ActivationPlan(p.SiteID, p.Enabled)
		if err != nil {
			return nil, &rpcError{Code: -32603, Message: err.Error()}
		}
		return plan, nil
	case "seo.suite200.dispatch":
		var p suite200DispatchParams
		if err := json.Unmarshal(params, &p); err != nil || p.SiteID == "" {
			return nil, &rpcError{Code: -32602, Message: "site_id, enabled, source_revision and input_hash are required"}
		}
		receipt, err := core.DispatchSuite200(ctx, s.queue, p.SiteID, p.Enabled, p.SourceRevision, p.InputHash, p.Payload)
		if err != nil {
			return nil, &rpcError{Code: -32603, Message: err.Error()}
		}
		return receipt, nil
	case "seo.suite200.status":
		var p suite200StatusParams
		if err := json.Unmarshal(params, &p); err != nil || len(p.JobIDs) == 0 {
			return nil, &rpcError{Code: -32602, Message: "job_ids are required"}
		}
		complete, failed := 0, 0
		for _, jobID := range p.JobIDs {
			if result, ok := s.queue.Result(jobID); ok {
				complete++
				if result.Err != "" {
					failed++
				}
			}
		}
		return map[string]any{"submitted": len(p.JobIDs), "complete": complete, "failed": failed}, nil
	case "seo.pagerank.submit":
		var p pageRankParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcError{Code: -32602, Message: "invalid params", Data: err.Error()}
		}
		if p.SourceRevision == "" || p.InputHash == "" || p.IdempotencyKey == "" {
			return nil, &rpcError{Code: -32602, Message: "source_revision, input_hash and idempotency_key are required"}
		}
		payload, err := json.Marshal(struct {
			Routes []string            `json:"routes"`
			Links  [][2]string         `json:"links"`
			Config core.PageRankConfig `json:"config"`
		}{p.Routes, p.Links, p.Config})
		if err != nil {
			return nil, &rpcError{Code: -32603, Message: err.Error()}
		}
		jobID, dedup, err := s.queue.Submit(ctx, core.JobEnvelope{
			ModuleID:       160,
			SourceRevision: p.SourceRevision,
			InputHash:      p.InputHash,
			IdempotencyKey: p.IdempotencyKey,
			Payload:        payload,
		})
		if err != nil {
			return nil, &rpcError{Code: -32603, Message: err.Error()}
		}
		return map[string]any{"job_id": jobID, "deduplicated": dedup, "status": "queued"}, nil
	case "seo.job.get":
		var p jobGetParams
		if err := json.Unmarshal(params, &p); err != nil || p.JobID == "" {
			return nil, &rpcError{Code: -32602, Message: "job_id is required"}
		}
		if result, ok := s.queue.Result(p.JobID); ok {
			return map[string]any{"status": "complete", "job": result}, nil
		}
		return map[string]any{"status": "queued_or_running", "job_id": p.JobID}, nil
	case "seo.semantic.submit":
		return s.semanticPOST(ctx, "/v1/semantic/jobs", params)
	case "seo.semantic.get":
		var p jobGetParams
		if err := json.Unmarshal(params, &p); err != nil || p.JobID == "" {
			return nil, &rpcError{Code: -32602, Message: "job_id is required"}
		}
		return s.semanticGET(ctx, "/v1/semantic/jobs/"+p.JobID)
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}
	}
}

func (s *server) semanticPOST(ctx context.Context, path string, body json.RawMessage) (any, *rpcError) {
	if s.semanticURL == "" {
		return nil, &rpcError{Code: -32603, Message: "SEMANTIC_SERVICE_URL is not configured"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.semanticURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, &rpcError{Code: -32603, Message: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	if s.semanticToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.semanticToken)
	}
	return s.doSemantic(req)
}

func (s *server) semanticGET(ctx context.Context, path string) (any, *rpcError) {
	if s.semanticURL == "" {
		return nil, &rpcError{Code: -32603, Message: "SEMANTIC_SERVICE_URL is not configured"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.semanticURL, "/")+path, nil)
	if err != nil {
		return nil, &rpcError{Code: -32603, Message: err.Error()}
	}
	if s.semanticToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.semanticToken)
	}
	return s.doSemantic(req)
}

func (s *server) doSemantic(req *http.Request) (any, *rpcError) {
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, &rpcError{Code: -32603, Message: "semantic service unavailable", Data: err.Error()}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, &rpcError{Code: -32603, Message: "semantic response read failed"}
	}
	var decoded any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &decoded); err != nil {
			return nil, &rpcError{Code: -32603, Message: "semantic service returned invalid JSON"}
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &rpcError{Code: -32010, Message: "semantic service rejected request", Data: decoded}
	}
	return decoded, nil
}

func pageRankWorker(ctx context.Context, job core.JobEnvelope) (json.RawMessage, error) {
	if job.ModuleID != 160 {
		return nil, fmt.Errorf("unsupported background module %d", job.ModuleID)
	}
	var p struct {
		Routes []string            `json:"routes"`
		Links  [][2]string         `json:"links"`
		Config core.PageRankConfig `json:"config"`
	}
	if err := json.Unmarshal(job.Payload, &p); err != nil {
		return nil, err
	}
	g, err := core.NewSparseGraph(p.Routes)
	if err != nil {
		return nil, err
	}
	for _, link := range p.Links {
		if err := g.AddLink(link[0], link[1]); err != nil {
			return nil, err
		}
	}
	scores, stats, err := g.Calculate(ctx, p.Config)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"scores": scores, "stats": stats})
}

func commanderWorker(ctx context.Context, job core.JobEnvelope) (json.RawMessage, error) {
	if job.ModuleID == 160 {
		var probe struct {
			Routes []string `json:"routes"`
		}
		if json.Unmarshal(job.Payload, &probe) == nil && len(probe.Routes) > 0 {
			return pageRankWorker(ctx, job)
		}
	}
	return core.ContractEvidenceHandler(ctx, job)
}

func (s *server) modules(w http.ResponseWriter, _ *http.Request) {
	mods, err := core.ModuleCatalog()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, mods)
}

func dashboard(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SEO AVENGERS 200 — The Commander</title><style>body{font:16px system-ui;max-width:980px;margin:8vh auto;padding:0 24px;background:#0b0b0b;color:#f5f2e8}h1{font-size:clamp(40px,7vw,92px);line-height:.9;letter-spacing:-.06em}small{opacity:.65}pre{white-space:pre-wrap;border-top:1px solid #444;padding-top:24px}</style></head><body><small>NEXUS BOT STUDIO / CONTROL PLANE</small><h1>THE<br>COMMANDER</h1><p>Control plane aislado. Nada en este panel entra al request path del renderer determinista de Nexus.</p><pre id="out">Cargando catálogo de 200 módulos…</pre><script type="module">fetch('/modules').then(r=>r.json()).then(x=>out.textContent=JSON.stringify(x,null,2)).catch(e=>out.textContent=String(e));</script></body></html>`)
}

func main() {
	addr := os.Getenv("NEXUS_COMMANDER_ADDR")
	if addr == "" {
		addr = ":8788"
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	queue := core.NewMemoryQueue(1024)
	queue.StartWorkers(ctx, 8, commanderWorker)
	s := &server{
		secret:        os.Getenv("NEXUS_SHARED_SECRET"),
		semanticURL:   os.Getenv("SEMANTIC_SERVICE_URL"),
		semanticToken: os.Getenv("SEMANTIC_SHARED_SECRET"),
		queue:         queue,
		httpClient:    &http.Client{Timeout: 4 * time.Second},
	}
	s.startSeoOutbox(ctx, os.Getenv("NEXUS_SEO_OUTBOX_DIR"), 250*time.Millisecond)
	mux := http.NewServeMux()
	mux.HandleFunc("/", dashboard)
	mux.HandleFunc("/modules", s.modules)
	mux.HandleFunc("/rpc", s.rpc)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })

	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("commander listening on %s", addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("commander stopped: %v", err)
		}
	}
	queue.Close()
}
