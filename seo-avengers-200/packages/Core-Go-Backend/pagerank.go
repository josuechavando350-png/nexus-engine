package core

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

var ErrEmptyGraph = errors.New("pagerank: empty graph")

type PageRankConfig struct {
	Damping       float64 `json:"damping"`
	Tolerance     float64 `json:"tolerance"`
	MaxIterations int     `json:"max_iterations"`
}

type PageRankStats struct {
	Iterations int     `json:"iterations"`
	ResidualL1 float64 `json:"residual_l1"`
	Converged  bool    `json:"converged"`
}

type SparseGraph struct {
	routes   []string
	index    map[string]int
	outgoing [][]int
}

func NewSparseGraph(routes []string) (*SparseGraph, error) {
	if len(routes) == 0 {
		return nil, ErrEmptyGraph
	}
	cp := append([]string(nil), routes...)
	sort.Strings(cp)
	uniq := cp[:0]
	for _, r := range cp {
		if r == "" {
			return nil, fmt.Errorf("pagerank: empty route")
		}
		if len(uniq) == 0 || uniq[len(uniq)-1] != r {
			uniq = append(uniq, r)
		}
	}
	idx := make(map[string]int, len(uniq))
	for i, r := range uniq {
		idx[r] = i
	}
	return &SparseGraph{routes: uniq, index: idx, outgoing: make([][]int, len(uniq))}, nil
}

func (g *SparseGraph) AddLink(from, to string) error {
	fi, ok := g.index[from]
	if !ok {
		return fmt.Errorf("pagerank: unknown source route %q", from)
	}
	ti, ok := g.index[to]
	if !ok {
		return fmt.Errorf("pagerank: unknown target route %q", to)
	}
	for _, existing := range g.outgoing[fi] {
		if existing == ti {
			return nil
		}
	}
	g.outgoing[fi] = append(g.outgoing[fi], ti)
	sort.Ints(g.outgoing[fi])
	return nil
}

func (g *SparseGraph) Calculate(ctx context.Context, cfg PageRankConfig) (map[string]float64, PageRankStats, error) {
	if len(g.routes) == 0 {
		return nil, PageRankStats{}, ErrEmptyGraph
	}
	vector, stats, err := g.StochasticMatrix().PerronFrobenius(ctx, cfg)
	if err != nil {
		return nil, stats, err
	}
	scores := make(map[string]float64, len(g.routes))
	for i, route := range g.routes {
		scores[route] = vector[i]
	}
	return scores, stats, nil
}
