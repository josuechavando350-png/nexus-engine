package core

import (
	"context"
	"fmt"
	"math"
)

// SparseStochasticMatrix is the row-stochastic transition matrix induced by
// the internal-link graph. Rows with no outgoing links are represented as
// dangling rows and redistributed uniformly by the solver.
type SparseStochasticMatrix struct {
	Size int     `json:"size"`
	Rows [][]int `json:"rows"`
}

func (g *SparseGraph) StochasticMatrix() SparseStochasticMatrix {
	rows := make([][]int, len(g.outgoing))
	for i := range g.outgoing {
		rows[i] = append([]int(nil), g.outgoing[i]...)
	}
	return SparseStochasticMatrix{Size: len(g.routes), Rows: rows}
}

// PerronFrobenius solves the dominant stationary vector of the damped sparse
// stochastic matrix using deterministic power iteration. The teleportation
// term makes the matrix primitive, so Perron-Frobenius yields a unique positive
// stationary vector for 0<damping<1.
func (m SparseStochasticMatrix) PerronFrobenius(ctx context.Context, cfg PageRankConfig) ([]float64, PageRankStats, error) {
	if m.Size < 1 || len(m.Rows) != m.Size {
		return nil, PageRankStats{}, fmt.Errorf("perron: invalid matrix size")
	}
	if cfg.Damping == 0 {
		cfg.Damping = 0.85
	}
	if cfg.Tolerance == 0 {
		cfg.Tolerance = 1e-12
	}
	if cfg.MaxIterations == 0 {
		cfg.MaxIterations = 200
	}
	if cfg.Damping <= 0 || cfg.Damping >= 1 {
		return nil, PageRankStats{}, fmt.Errorf("perron: damping must be in (0,1)")
	}
	if cfg.Tolerance <= 0 || cfg.MaxIterations < 1 {
		return nil, PageRankStats{}, fmt.Errorf("perron: invalid convergence config")
	}

	n := m.Size
	invN := 1.0 / float64(n)
	v := make([]float64, n)
	for i := range v {
		v[i] = invN
	}
	stats := PageRankStats{}
	for iter := 1; iter <= cfg.MaxIterations; iter++ {
		if err := ctx.Err(); err != nil {
			return nil, stats, err
		}
		next := make([]float64, n)
		base := (1.0 - cfg.Damping) * invN
		for i := range next {
			next[i] = base
		}
		dangling := 0.0
		for from, outs := range m.Rows {
			if len(outs) == 0 {
				dangling += v[from]
				continue
			}
			mass := cfg.Damping * v[from] / float64(len(outs))
			for _, to := range outs {
				if to < 0 || to >= n {
					return nil, stats, fmt.Errorf("perron: column out of range")
				}
				next[to] += mass
			}
		}
		if dangling != 0 {
			mass := cfg.Damping * dangling * invN
			for i := range next {
				next[i] += mass
			}
		}
		residual, sum := 0.0, 0.0
		for i := range next {
			residual += math.Abs(next[i] - v[i])
			sum += next[i]
		}
		if sum == 0 {
			return nil, stats, fmt.Errorf("perron: zero mass")
		}
		for i := range next {
			next[i] /= sum
		}
		v = next
		stats = PageRankStats{Iterations: iter, ResidualL1: residual, Converged: residual <= cfg.Tolerance}
		if stats.Converged {
			break
		}
	}
	return v, stats, nil
}
