import { object, array, id, integer, rational, mul, add, div, sub, fmt, ZERO, ONE } from './shared.mjs';

function eventOf(event) {
  object(event, 'Bayes event', ['id', 'time', 'likelihoodIfTrue', 'likelihoodIfFalse']);
  return { id: id(event.id, 'event.id'), time: integer(event.time, 'event.time', 0, 1_000_000_000_000_000),
    likelihoodIfTrue: fmt(rational(event.likelihoodIfTrue, 'likelihoodIfTrue', { probability: true })),
    likelihoodIfFalse: fmt(rational(event.likelihoodIfFalse, 'likelihoodIfFalse', { probability: true })) };
}
function replay(prior, events) {
  const sorted = [...events].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  let p = prior, evidence = ONE;
  const timeline = [];
  for (const ev of sorted) {
    const lt = rational(ev.likelihoodIfTrue, 'likelihoodIfTrue', { probability: true });
    const lf = rational(ev.likelihoodIfFalse, 'likelihoodIfFalse', { probability: true });
    const weightedT = mul(p, lt), weightedF = mul(sub(ONE, p), lf);
    const predictive = add(weightedT, weightedF);
    if (predictive[0] === 0n) throw new TypeError(`event ${ev.id} has zero probability under current posterior`);
    p = div(weightedT, predictive);
    evidence = mul(evidence, predictive);
    timeline.push({ id: ev.id, time: ev.time, posteriorTrue: fmt(p), predictiveProbability: fmt(predictive) });
  }
  return { engine: 'NEMESIS_BINARY_BAYES_EVENT_STREAM_V1', priorTrue: fmt(prior), posteriorTrue: fmt(p),
    posteriorFalse: fmt(sub(ONE, p)), jointEvidenceProbability: fmt(evidence), processedEvents: timeline.length, timeline,
    assumptions: 'Given hypothesis, evidence events are conditionally independent with supplied fixed likelihoods. Event time orders the audit only; no automatic drift, correlation or causal discovery.' };
}
/** Stateful in-memory stream: duplicate IDs idempotent, event insertion transactional, late events replayed by timestamp. */
export function createBinaryBayesStream(priorTrue) {
  const prior = rational(priorTrue, 'priorTrue', { probability: true });
  const events = new Map(); let report = replay(prior, []);
  return Object.freeze({
    ingest(raw) {
      const event = eventOf(raw), existing = events.get(event.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) throw new TypeError(`conflicting event id: ${event.id}`);
        return { duplicate: true, report: structuredClone(report) };
      }
      if (events.size >= 1024) throw new RangeError('event stream capacity exceeded');
      const candidate = new Map(events); candidate.set(event.id, event);
      const result = replay(prior, candidate.values()); // no state change when probability is impossible
      events.set(event.id, event); report = result;
      return { duplicate: false, report: structuredClone(result) };
    },
    snapshot() { return structuredClone(report); },
  });
}
export function updateBinaryBayesEvents(input) {
  object(input, 'Bayes stream', ['priorTrue', 'events']);
  const stream = createBinaryBayesStream(input.priorTrue);
  for (const event of array(input.events, 'events', 0, 1024)) stream.ingest(event);
  return stream.snapshot();
}
