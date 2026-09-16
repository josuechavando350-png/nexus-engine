// NEXUS-owned, bounded graph algorithms. Numeric costs are safe integers:
// reported optima are exact within JavaScript's safe-integer arithmetic.
const boundedInt = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be a safe integer in [${min},${max}]`);
  return value;
};
const vertexCount = value => boundedInt(value, 'vertexCount', 1, 128);
const boundedEdges = (edges, n, name = 'edges', max = 4096) => {
  if (!Array.isArray(edges) || edges.length > max) throw new TypeError(`${name} must have at most ${max} entries`);
  return edges.map((edge, index) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new TypeError(`${name}[${index}] must be an edge`);
    const from = boundedInt(edge.from, `${name}[${index}].from`, 0, n - 1);
    const to = boundedInt(edge.to, `${name}[${index}].to`, 0, n - 1);
    if (from === to) throw new TypeError('self edges are forbidden');
    return { from, to, edge, index };
  });
};
const frozen = value => Object.freeze(value);

export function shortestPathDijkstra({ vertexCount: count, edges, source, target }) {
  const n = vertexCount(count);
  const start = boundedInt(source, 'source', 0, n - 1);
  const end = boundedInt(target, 'target', 0, n - 1);
  const adjacency = Array.from({ length: n }, () => []);
  for (const { from, to, edge, index } of boundedEdges(edges, n)) {
    adjacency[from].push({ to, cost: boundedInt(edge.cost, `edges[${index}].cost`, 0, 1_000_000) });
  }
  for (const row of adjacency) row.sort((a, b) => a.to - b.to || a.cost - b.cost);
  const distance = Array(n).fill(Infinity);
  const previous = Array(n).fill(-1);
  const visited = Array(n).fill(false);
  distance[start] = 0;
  let examined = 0;
  for (let step = 0; step < n; step += 1) {
    let u = -1;
    for (let i = 0; i < n; i += 1) if (!visited[i] && (u < 0 || distance[i] < distance[u])) u = i;
    if (u < 0 || distance[u] === Infinity) break;
    visited[u] = true;
    examined += 1;
    if (u === end) break;
    for (const { to, cost } of adjacency[u]) {
      const candidate = distance[u] + cost;
      if (!visited[to] && candidate < distance[to]) {
        distance[to] = candidate;
        previous[to] = u;
      }
    }
  }
  if (distance[end] === Infinity) return frozen({ reachable: false, distance: null, path: frozen([]), examinedVertices: examined });
  const path = [];
  for (let current = end; current !== -1; current = previous[current]) path.push(current);
  path.reverse();
  return frozen({ reachable: true, distance: distance[end], path: frozen(path), examinedVertices: examined });
}

export function minimumSpanningForest({ vertexCount: count, edges }) {
  const n = vertexCount(count);
  const seen = new Set();
  const sorted = boundedEdges(edges, n).map(({ from, to, edge, index }) => {
    const u = Math.min(from, to);
    const v = Math.max(from, to);
    const key = `${u}:${v}`;
    if (seen.has(key)) throw new TypeError('undirected duplicate edge');
    seen.add(key);
    return { u, v, weight: boundedInt(edge.weight, `edges[${index}].weight`, -1_000_000, 1_000_000) };
  }).sort((a, b) => a.weight - b.weight || a.u - b.u || a.v - b.v);
  const parent = Array.from({ length: n }, (_, index) => index);
  const rank = Array(n).fill(0);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  let components = n;
  let totalWeight = 0;
  const selectedEdges = [];
  for (const edge of sorted) {
    let a = find(edge.u);
    let b = find(edge.v);
    if (a === b) continue;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a] += 1;
    components -= 1;
    totalWeight += edge.weight;
    selectedEdges.push(frozen(edge));
  }
  return frozen({ totalWeight, components, selectedEdges: frozen(selectedEdges) });
}

export function maximumFlowMinimumCut({ vertexCount: count, edges, source, sink }) {
  const n = boundedInt(count, 'vertexCount', 2, 64);
  const s = boundedInt(source, 'source', 0, n - 1);
  const t = boundedInt(sink, 'sink', 0, n - 1);
  if (s === t) throw new TypeError('source and sink must differ');
  const capacity = Array.from({ length: n }, () => Array(n).fill(0));
  for (const { from, to, edge, index } of boundedEdges(edges, n, 'edges', 1024)) {
    const c = boundedInt(edge.capacity, `edges[${index}].capacity`, 0, 1_000_000);
    capacity[from][to] += c;
  }
  const residual = capacity.map(row => [...row]);
  let maximumFlow = 0;
  let augmentations = 0;
  while (true) {
    const previous = Array(n).fill(-1);
    previous[s] = s;
    const queue = [s];
    for (let q = 0; q < queue.length && previous[t] < 0; q += 1) {
      const u = queue[q];
      for (let v = 0; v < n; v += 1) {
        if (previous[v] < 0 && residual[u][v] > 0) {
          previous[v] = u;
          queue.push(v);
        }
      }
    }
    if (previous[t] < 0) break;
    let bottleneck = Infinity;
    for (let v = t; v !== s; v = previous[v]) bottleneck = Math.min(bottleneck, residual[previous[v]][v]);
    for (let v = t; v !== s; v = previous[v]) {
      const u = previous[v];
      residual[u][v] -= bottleneck;
      residual[v][u] += bottleneck;
    }
    maximumFlow += bottleneck;
    augmentations += 1;
  }
  const inCut = Array(n).fill(false);
  inCut[s] = true;
  const queue = [s];
  for (let q = 0; q < queue.length; q += 1) {
    const u = queue[q];
    for (let v = 0; v < n; v += 1) if (!inCut[v] && residual[u][v] > 0) {
      inCut[v] = true;
      queue.push(v);
    }
  }
  const sourceSide = queue.sort((a, b) => a - b);
  let cutCapacity = 0;
  for (let u = 0; u < n; u += 1) if (inCut[u]) {
    for (let v = 0; v < n; v += 1) if (!inCut[v]) cutCapacity += capacity[u][v];
  }
  if (cutCapacity !== maximumFlow) throw new Error('max-flow/min-cut invariant violated');
  return frozen({ maximumFlow, cutCapacity, sourceSide: frozen(sourceSide), augmentations });
}

export function stronglyConnectedComponents({ vertexCount: count, edges }) {
  const n = vertexCount(count);
  const adjacency = Array.from({ length: n }, () => []);
  const unique = new Set();
  for (const { from, to } of boundedEdges(edges, n)) {
    const key = `${from}:${to}`;
    if (unique.has(key)) throw new TypeError('duplicate directed edge');
    unique.add(key);
    adjacency[from].push(to);
  }
  for (const neighbors of adjacency) neighbors.sort((a, b) => a - b);
  let nextIndex = 0;
  const indexOf = Array(n).fill(-1);
  const low = Array(n).fill(-1);
  const stack = [];
  const onStack = Array(n).fill(false);
  const components = [];
  function visit(u) {
    indexOf[u] = low[u] = nextIndex++;
    stack.push(u);
    onStack[u] = true;
    for (const v of adjacency[u]) {
      if (indexOf[v] === -1) {
        visit(v);
        low[u] = Math.min(low[u], low[v]);
      } else if (onStack[v]) low[u] = Math.min(low[u], indexOf[v]);
    }
    if (low[u] === indexOf[u]) {
      const component = [];
      while (true) {
        const v = stack.pop();
        onStack[v] = false;
        component.push(v);
        if (v === u) break;
      }
      component.sort((a, b) => a - b);
      components.push(frozen(component));
    }
  }
  for (let u = 0; u < n; u += 1) if (indexOf[u] === -1) visit(u);
  components.sort((a, b) => a[0] - b[0]);
  return frozen({ componentCount: components.length, components: frozen(components) });
}

export function bipartiteMaximumMatching({ leftCount, rightCount, edges }) {
  const left = boundedInt(leftCount, 'leftCount', 1, 64);
  const right = boundedInt(rightCount, 'rightCount', 1, 64);
  if (!Array.isArray(edges) || edges.length > 4096) throw new TypeError('edges must be a bounded array');
  const adj = Array.from({ length: left }, () => []);
  const seen = new Set();
  for (const [index, edge] of edges.entries()) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new TypeError('edge must be object');
    const u = boundedInt(edge.left, `edges[${index}].left`, 0, left - 1);
    const v = boundedInt(edge.right, `edges[${index}].right`, 0, right - 1);
    const key = `${u}:${v}`;
    if (seen.has(key)) throw new TypeError('duplicate bipartite edge');
    seen.add(key);
    adj[u].push(v);
  }
  for (const row of adj) row.sort((a, b) => a - b);
  const rightMate = Array(right).fill(-1);
  function augment(u, seenRight) {
    for (const v of adj[u]) if (!seenRight[v]) {
      seenRight[v] = true;
      if (rightMate[v] === -1 || augment(rightMate[v], seenRight)) {
        rightMate[v] = u;
        return true;
      }
    }
    return false;
  }
  for (let u = 0; u < left; u += 1) augment(u, Array(right).fill(false));
  const pairs = rightMate.flatMap((u, v) => u === -1 ? [] : [{ left: u, right: v }])
    .sort((a, b) => a.left - b.left || a.right - b.right).map(frozen);
  return frozen({ size: pairs.length, pairs: frozen(pairs), unmatchedLeft: frozen(Array.from({ length: left }, (_, i) => i).filter(u => !pairs.some(pair => pair.left === u))) });
}

export function directedAcyclicSchedule({ durations, dependencies }) {
  if (!Array.isArray(durations) || durations.length < 1 || durations.length > 128) throw new TypeError('durations must be a bounded nonempty array');
  const n = durations.length;
  const jobs = durations.map((d, i) => boundedInt(d, `durations[${i}]`, 0, 1_000_000));
  const graph = Array.from({ length: n }, () => []);
  const inDegree = Array(n).fill(0);
  const seen = new Set();
  for (const { from, to } of boundedEdges(dependencies, n, 'dependencies')) {
    const key = `${from}:${to}`;
    if (seen.has(key)) throw new TypeError('duplicate dependency');
    seen.add(key);
    graph[from].push(to);
    inDegree[to] += 1;
  }
  for (const row of graph) row.sort((a, b) => a - b);
  const earliestStart = Array(n).fill(0);
  const predecessor = Array(n).fill(-1);
  const order = [];
  const used = Array(n).fill(false);
  for (let step = 0; step < n; step += 1) {
    let u = -1;
    for (let v = 0; v < n; v += 1) if (!used[v] && inDegree[v] === 0) { u = v; break; }
    if (u === -1) throw new TypeError('dependencies contain a directed cycle');
    used[u] = true;
    order.push(u);
    for (const v of graph[u]) {
      const next = earliestStart[u] + jobs[u];
      if (next > earliestStart[v]) {
        earliestStart[v] = next;
        predecessor[v] = u;
      }
      inDegree[v] -= 1;
    }
  }
  const earliestFinish = jobs.map((duration, i) => earliestStart[i] + duration);
  let last = order[0];
  for (const v of order) if (earliestFinish[v] > earliestFinish[last]) last = v;
  const criticalPath = [];
  for (let v = last; v !== -1; v = predecessor[v]) criticalPath.push(v);
  criticalPath.reverse();
  return frozen({ makespan: earliestFinish[last], order: frozen(order), earliestStart: frozen(earliestStart), earliestFinish: frozen(earliestFinish), criticalPath: frozen(criticalPath) });
}

export function exactTravelingSalesperson({ distances }) {
  if (!Array.isArray(distances) || distances.length < 1 || distances.length > 11) throw new TypeError('distances must be a 1..11 square matrix');
  const n = distances.length;
  const weights = distances.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) throw new TypeError('distances must be square');
    return row.map((value, j) => {
      const d = boundedInt(value, `distances[${i}][${j}]`, 0, 1_000_000);
      if (i === j && d !== 0) throw new TypeError('distance diagonal must be zero');
      return d;
    });
  });
  if (n === 1) return frozen({ minimumCost: 0, tour: frozen([0, 0]), evaluatedTransitions: 0 });
  const stateCount = 1 << (n - 1);
  const dp = Array.from({ length: stateCount }, () => Array(n).fill(Infinity));
  const parent = Array.from({ length: stateCount }, () => Array(n).fill(-1));
  let evaluatedTransitions = 0;
  for (let j = 1; j < n; j += 1) dp[1 << (j - 1)][j] = weights[0][j];
  for (let mask = 1; mask < stateCount; mask += 1) {
    for (let j = 1; j < n; j += 1) {
      const bit = 1 << (j - 1);
      if (!(mask & bit)) continue;
      const prevMask = mask ^ bit;
      if (!prevMask) continue;
      for (let k = 1; k < n; k += 1) if (prevMask & (1 << (k - 1))) {
        evaluatedTransitions += 1;
        const candidate = dp[prevMask][k] + weights[k][j];
        if (candidate < dp[mask][j]) { dp[mask][j] = candidate; parent[mask][j] = k; }
      }
    }
  }
  const all = stateCount - 1;
  let bestCost = Infinity;
  let last = -1;
  for (let j = 1; j < n; j += 1) {
    const candidate = dp[all][j] + weights[j][0];
    if (candidate < bestCost) { bestCost = candidate; last = j; }
  }
  const reversed = [];
  for (let mask = all, at = last; at > 0;) {
    reversed.push(at);
    const next = parent[mask][at];
    mask ^= 1 << (at - 1);
    at = next;
  }
  const tour = [0, ...reversed.reverse(), 0];
  const auditedCost = tour.slice(1).reduce((sum, to, index) => sum + weights[tour[index]][to], 0);
  if (auditedCost !== bestCost || new Set(tour.slice(0, -1)).size !== n) throw new Error('TSP witness failed');
  return frozen({ minimumCost: bestCost, tour: frozen(tour), evaluatedTransitions });
}

export function stationaryPageRank({ vertexCount: count, edges, damping = 0.85, tolerance = 1e-11, maxIterations = 10000 }) {
  const n = vertexCount(count);
  if (typeof damping !== 'number' || !Number.isFinite(damping) || damping <= 0 || damping >= 1) throw new TypeError('damping must be in (0,1)');
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1e-3) throw new TypeError('invalid tolerance');
  const limit = boundedInt(maxIterations, 'maxIterations', 1, 10000);
  const outgoing = Array.from({ length: n }, () => []);
  const seen = new Set();
  for (const { from, to } of boundedEdges(edges, n)) {
    const key = `${from}:${to}`;
    if (seen.has(key)) throw new TypeError('duplicate directed edge');
    seen.add(key);
    outgoing[from].push(to);
  }
  let rank = Array(n).fill(1 / n);
  for (let iteration = 1; iteration <= limit; iteration += 1) {
    const next = Array(n).fill((1 - damping) / n);
    for (let u = 0; u < n; u += 1) {
      if (!outgoing[u].length) {
        const share = damping * rank[u] / n;
        for (let v = 0; v < n; v += 1) next[v] += share;
      } else {
        const share = damping * rank[u] / outgoing[u].length;
        for (const v of outgoing[u]) next[v] += share;
      }
    }
    const residual = next.reduce((sum, value, v) => sum + Math.abs(value - rank[v]), 0);
    rank = next;
    if (residual <= tolerance) {
      const mass = rank.reduce((sum, value) => sum + value, 0);
      if (Math.abs(mass - 1) > 1e-10 || rank.some(value => !Number.isFinite(value) || value < 0)) throw new Error('PageRank probability invariant violated');
      return frozen({ scores: frozen(rank), iterations: iteration, l1Residual: residual });
    }
  }
  throw new Error('PageRank did not converge within maxIterations');
}
