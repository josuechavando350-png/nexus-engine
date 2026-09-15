package core

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestDispatchSuite200FansOutEveryContract(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	q := NewMemoryQueue(256)
	q.StartWorkers(ctx, 8, ContractEvidenceHandler)
	payload, _ := json.Marshal(map[string]any{"route": "/", "text": "Walle controlled proof"})
	receipt, err := DispatchSuite200(ctx, q, "walle-proof-probe", true, "abcdef1234567890", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payload)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Submitted != 200 || len(receipt.JobIDs) != 200 || len(receipt.States) != 200 {
		t.Fatalf("receipt=%+v", receipt)
	}
	for _, id := range []int{18, 21, 23, 25, 50} {
		if receipt.States[id] != "ADVISORY" {
			t.Fatalf("policy-sensitive module %d escaped advisory state: %+v", id, receipt.States)
		}
	}
	if receipt.States[27] != "GATED" || receipt.States[30] != "ADVISORY" || receipt.States[31] != "GATED" || receipt.States[39] != "GATED" {
		t.Fatalf("existing policy gates drifted: %+v", receipt.States)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		complete := 0
		for _, id := range receipt.JobIDs {
			if _, ok := q.Result(id); ok {
				complete++
			}
		}
		if complete == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/200 jobs completed", complete)
		}
		time.Sleep(5 * time.Millisecond)
	}
	q.Close()
}
