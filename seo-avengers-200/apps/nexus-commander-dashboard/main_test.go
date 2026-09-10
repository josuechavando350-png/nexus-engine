package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	core "github.com/nexusbotstudio/seo-avengers-200/core"
)

func TestModulesList(t *testing.T) {
	s := &server{queue: core.NewMemoryQueue(8)}
	v, e := s.dispatch(context.Background(), "seo.modules.list", json.RawMessage(`{}`))
	if e != nil {
		t.Fatal(e.Message)
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice || rv.Len() != 200 {
		t.Fatalf("expected 200 modules, got %#v", v)
	}
}

func TestPageRankIsQueued(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	q := core.NewMemoryQueue(8)
	q.StartWorkers(ctx, 1, pageRankWorker)
	defer q.Close()
	s := &server{queue: q}
	params := json.RawMessage(`{
		"routes":["/","/a","/b"],
		"links":[["/","/a"],["/a","/b"],["/b","/a"]],
		"config":{},
		"source_revision":"abcdef1",
		"input_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"idempotency_key":"test-1"
	}`)
	v, e := s.dispatch(ctx, "seo.pagerank.submit", params)
	if e != nil {
		t.Fatal(e.Message)
	}
	jobID := v.(map[string]any)["job_id"].(string)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if result, ok := q.Result(jobID); ok {
			if result.Err != "" {
				t.Fatal(result.Err)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("queued pagerank job did not complete")
}

func TestProcessSeoOutboxOncePostsAndArchives(t *testing.T) {
	t.Parallel()
	var gotAuth string
	var gotAuthority string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		gotAuthority, _ = body["authority"].(string)
		writeJSON(w, http.StatusAccepted, map[string]any{"job_id": "abc", "deduplicated": false, "status": "queued"})
	}))
	defer upstream.Close()

	root := t.TempDir()
	outbox := filepath.Join(root, "outbox")
	if err := os.MkdirAll(outbox, 0o750); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"authority":"NEXUS_SEO_AVENGERS_200_SECTION_V1","schema_version":2,"site_id":"nexus-bot-studio","route":"/","section_id":"hero","locale":"es-MX","canonical_origin":"https://nexusbotstudio.com","text":"Nexus Bot Studio","keyword":null,"source_revision":"abcdef1234567","input_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","idempotency_key":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`)
	name := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
	if err := os.WriteFile(filepath.Join(outbox, name), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	s := &server{semanticURL: upstream.URL, semanticToken: "secret", httpClient: upstream.Client()}
	processed, err := s.processSeoOutboxOnce(context.Background(), outbox)
	if err != nil {
		t.Fatal(err)
	}
	if processed != 1 {
		t.Fatalf("processed=%d", processed)
	}
	if gotAuth != "Bearer secret" {
		t.Fatalf("auth=%q", gotAuth)
	}
	if gotAuthority != sectionAuthority {
		t.Fatalf("authority=%q", gotAuthority)
	}
	if _, err := os.Stat(filepath.Join(root, "processed", name)); err != nil {
		t.Fatalf("processed file missing: %v", err)
	}
}

func TestClientActivationRPCReturnsTwoHundredModules(t *testing.T) {
	s := &server{queue: core.NewMemoryQueue(8)}
	v, rpcErr := s.dispatch(context.Background(), "seo.client.activation", json.RawMessage(`{"site_id":"nexus-bot-studio","enabled":true}`))
	if rpcErr != nil {
		t.Fatal(rpcErr.Message)
	}
	plan, ok := v.(core.ClientActivationPlan)
	if !ok {
		t.Fatalf("unexpected type %T", v)
	}
	if !plan.Enabled || len(plan.Modules) != 200 {
		t.Fatalf("plan=%+v", plan)
	}
}
