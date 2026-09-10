package core

import (
	"context"
	"math"
	"testing"
)

func TestPageRankConvergesAndNormalizes(t *testing.T) {
	g, err := NewSparseGraph([]string{"/", "/a", "/b", "/c"})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range [][2]string{{"/", "/a"}, {"/", "/b"}, {"/a", "/b"}, {"/b", "/a"}, {"/c", "/"}} {
		if err := g.AddLink(e[0], e[1]); err != nil {
			t.Fatal(err)
		}
	}
	scores, stats, err := g.Calculate(context.Background(), PageRankConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if !stats.Converged {
		t.Fatalf("expected convergence: %+v", stats)
	}
	sum := 0.0
	for _, v := range scores {
		if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			t.Fatalf("invalid score %v", v)
		}
		sum += v
	}
	if math.Abs(sum-1.0) > 1e-10 {
		t.Fatalf("rank sum=%0.16f", sum)
	}
	if !(scores["/a"] > scores["/"] && scores["/b"] > scores["/"]) {
		t.Fatalf("unexpected ordering: %#v", scores)
	}
}

func TestCatalogHas200NonBlockingModules(t *testing.T) {
	mods, err := ModuleCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(mods) != 200 {
		t.Fatalf("got %d modules", len(mods))
	}
	for _, m := range mods {
		if m.RequestPathBlocking {
			t.Fatalf("%s is blocking", m.Key)
		}
	}
}
