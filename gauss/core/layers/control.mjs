import { assertFiniteNumber, assertSafeInteger, seededXorShift32 } from "../common.mjs";

export function finiteHorizonScalarLQR({ a, b, q, r, terminalQ, horizon, initialState }) {
  const A = assertFiniteNumber(a, "a");
  const B = assertFiniteNumber(b, "b");
  const Q = assertFiniteNumber(q, "q", { min: 0 });
  const R = assertFiniteNumber(r, "r", { min: Number.EPSILON });
  const Qf = assertFiniteNumber(terminalQ, "terminalQ", { min: 0 });
  const T = assertSafeInteger(horizon, "horizon", { min: 1, max: 100_000 });
  let x = assertFiniteNumber(initialState, "initialState");
  const gains = new Array(T);
  const riccati = new Array(T + 1);
  riccati[T] = Qf;
  for (let t = T - 1; t >= 0; t -= 1) {
    const denom = R + B * B * riccati[t + 1];
    const k = (B * riccati[t + 1] * A) / denom;
    gains[t] = k;
    riccati[t] = Q + A * A * riccati[t + 1] - A * B * riccati[t + 1] * k;
  }
  const trajectory = [x];
  const controls = [];
  let totalCost = 0;
  for (let t = 0; t < T; t += 1) {
    const u = -gains[t] * x;
    totalCost += Q * x * x + R * u * u;
    controls.push(u);
    x = A * x + B * u;
    trajectory.push(x);
  }
  totalCost += Qf * x * x;
  return Object.freeze({
    gains: Object.freeze(gains),
    riccati: Object.freeze(riccati),
    controls: Object.freeze(controls),
    trajectory: Object.freeze(trajectory),
    totalCost,
  });
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function eulerMaruyama({ x0, mu, sigma, dt, steps, seed = 1 }) {
  let x = assertFiniteNumber(x0, "x0");
  const drift = assertFiniteNumber(mu, "mu");
  const diffusion = assertFiniteNumber(sigma, "sigma", { min: 0 });
  const delta = assertFiniteNumber(dt, "dt", { min: Number.EPSILON });
  const count = assertSafeInteger(steps, "steps", { min: 1, max: 1_000_000 });
  const rng = seededXorShift32(seed);
  const trajectory = [x];
  const sqrtDt = Math.sqrt(delta);
  for (let index = 0; index < count; index += 1) {
    x += drift * delta + diffusion * sqrtDt * gaussian(rng);
    trajectory.push(x);
  }
  return Object.freeze({ trajectory: Object.freeze(trajectory), finalState: x, steps: count, seed });
}
