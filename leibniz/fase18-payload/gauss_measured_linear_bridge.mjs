// Bounded integration of source-pinned LEIBNIZ measured rates into an explicitly
// supplied GAUSS linear system. NO claim of causal, predictive, or ZK proof.
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { executeGaussProblem, validateGaussProblem } from '../../gauss/core/problem.mjs';
import { contributeNexusQuantum } from '../../gauss/core/quantum-contributor.mjs';

const HEADER = 'LEIBNIZ_MEASURED_RATE_V1';
const SOLVER = 'GAUSS.MATH.GAUSSIAN_SOLVE.005';
const MAX_ARCHIVE = 81 * 1024 * 1024;
const MAX_ROWS = 32;
const DECODER = new TextDecoder('utf-8', { fatal: true });
const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function readLabel(raw, label) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length % 2 !== 0 || !/^(?:[a-f0-9]{2})+$/u.test(raw)) {
    throw new Error(`${label}: noncanonical hex encoding`);
  }
  const text = DECODER.decode(Buffer.from(raw, 'hex'));
  if (!text.trim()) throw new Error(`${label}: empty value`);
  return text;
}
function readFloatBits(raw) {
  if (!/^[a-f0-9]{16}$/u.test(raw ?? '')) throw new Error('invalid binary64 bits');
  const value = Buffer.from(raw, 'hex').readDoubleBE(0);
  if (!Number.isFinite(value) || Object.is(value, -0) || Math.abs(value) > 1e9) {
    throw new Error('nonfinite, signed-zero, or out-of-bound rate');
  }
  return value;
}
function readDimensions(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw) throw new Error('missing dimensions');
  const fields = raw.split(',');
  const dimensions = Object.create(null);
  for (const field of fields) {
    const match = /^((?:[a-f0-9]{2})+)=(-?(?:[1-9][0-9]*))$/u.exec(field);
    if (!match) throw new Error('invalid dimension declaration');
    const name = readLabel(match[1], 'dimension');
    const power = Number(match[2]);
    if (Object.hasOwn(dimensions, name) || !Number.isSafeInteger(power) || power < -32768 || power > 32767 || power === 0) {
      throw new Error('repeated or invalid dimension');
    }
    dimensions[name] = power;
  }
  if (dimensions.time !== -1) throw new Error('rate must have explicit inverse-time dimension');
  return Object.freeze(dimensions);
}

export function parseMeasuredRateLine(line) {
  if (typeof line !== 'string' || line.length > 65_536) throw new Error('bridge record length exceeded');
  const text = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (text.includes('\n') || text.includes('\r')) throw new Error('multiple lines or control characters');
  const columns = text.split('\t');
  if (columns[0] !== HEADER || columns.length < 10) throw new Error('unexpected bridge protocol');
  const [, idHex, instantText, fromHex, toHex, bits, unitHex, dimensionText, countText, ...evidenceHex] = columns;
  const problemId = readLabel(idHex, 'problem id');
  if (!token.test(problemId)) throw new Error('invalid GAUSS problem identifier');
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(instantText)) throw new Error('invalid timestamp');
  const asOfUtcMs = Number(instantText);
  if (!Number.isSafeInteger(asOfUtcMs)) throw new Error('timestamp outside exact integer range');
  const fromEntity = readLabel(fromHex, 'source entity');
  const toEntity = readLabel(toHex, 'target entity');
  if (fromEntity === toEntity) throw new Error('same source and target entity');
  const unit = readLabel(unitHex, 'unit');
  const dimensions = readDimensions(dimensionText);
  if (!/^[1-9][0-9]*$/u.test(countText) || Number(countText) !== evidenceHex.length || evidenceHex.length > 1000) {
    throw new Error('bridge evidence count mismatch');
  }
  const evidenceIds = evidenceHex.map((s) => readLabel(s, 'evidence id'));
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('duplicate evidence id');
  return Object.freeze({ problemId, asOfUtcMs, fromEntity, toEntity, value: readFloatBits(bits),
    valueBits: bits, unit, dimensions, evidenceIds: Object.freeze(evidenceIds) });
}

function pinnedSource(archivePath, pinPath) {
  if (realpathSync(archivePath) === realpathSync(pinPath)) throw new Error('source and pin must be distinct files');
  for (const path of [archivePath, pinPath]) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE) {
      throw new Error('bridge source must be a bounded regular file');
    }
  }
  const first = statSync(archivePath);
  const second = statSync(pinPath);
  if (first.dev === second.dev && first.ino === second.ino) throw new Error('source and pin are hardlinks');
  const archive = readFileSync(archivePath);
  const pinned = readFileSync(pinPath);
  if (!archive.length || archive.length > MAX_ARCHIVE || archive.length !== pinned.length
    || !timingSafeEqual(archive, pinned)) throw new Error('archive differs from independent pin');
  return createHash('sha256').update(pinned).digest('hex');
}

function boundedMatrix(coefficients, n) {
  if (!Array.isArray(coefficients) || coefficients.length !== n) throw new Error('matrix row count mismatch');
  return coefficients.map((row) => {
    if (!Array.isArray(row) || row.length !== n || row.some((v) =>
      typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9)) {
      throw new Error('matrix must be finite, square, and bounded');
    }
    return [...row];
  });
}

/**
 * The operator supplies: a trusted Rust binary, independent source pin, an
 * explicit linear model (the coefficients), and authorized source selections.
 * Multiple rates are measured from the SAME source archive, at the SAME time,
 * in the SAME unit and dimension. Matrix coefficients are assumptions, never
 * derived causal facts. Nothing here certifies the pin's issuer or origin.
 */
export async function runMeasuredLinearBridge({ binaryPath, archivePath, pinPath, problemId,
  asOfUtcMs, selections, coefficients, direction = 'MAXIMIZE' }) {
  if (typeof binaryPath !== 'string' || !binaryPath || !token.test(problemId ?? '')
    || !Number.isSafeInteger(asOfUtcMs) || !['MAXIMIZE', 'MINIMIZE'].includes(direction)
    || !Array.isArray(selections) || selections.length < 1 || selections.length > MAX_ROWS) {
    throw new Error('invalid bounded LEIBNIZ bridge request');
  }
  const sourceSha256 = pinnedSource(archivePath, pinPath);
  const matrix = boundedMatrix(coefficients, selections.length);
  const seen = new Set();
  const rates = selections.map((selection) => {
    const { fromEntity, toEntity, unit } = selection ?? {};
    if (![fromEntity, toEntity, unit].every((v) => typeof v === 'string' && v.trim() && v.length <= 1024)) {
      throw new Error('invalid selected source, target, or unit');
    }
    const pair = `${fromEntity.length}:${fromEntity}${toEntity.length}:${toEntity}`;
    if (seen.has(pair)) throw new Error('duplicate directed edge');
    seen.add(pair);
    const stdout = execFileSync(binaryPath, [archivePath, pinPath, problemId,
      String(asOfUtcMs), fromEntity, toEntity, unit, direction], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536, windowsHide: true,
    });
    const row = parseMeasuredRateLine(stdout);
    if (row.problemId !== problemId || row.asOfUtcMs !== asOfUtcMs || row.fromEntity !== fromEntity
      || row.toEntity !== toEntity || row.unit !== unit) throw new Error('Rust bridge returned a different selection');
    return row;
  });
  const first = rates[0];
  const signature = JSON.stringify(first.dimensions);
  if (rates.some((r) => r.unit !== first.unit || JSON.stringify(r.dimensions) !== signature)) {
    throw new Error('incompatible units or dimensions cannot share one linear system');
  }
  const rhs = rates.map((r) => r.value);
  const problem = validateGaussProblem({ schemaVersion: 1, problemId: `${problemId}:linear`,
    objective: 'Source-pinned measured-rate linear system; coefficients supplied by operator; no forecast',
    tasks: [{ taskId: 'measured-linear-system', layerId: SOLVER, input: { coefficients: matrix, rhs } }],
  });
  const report = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
  if (report.status !== 'PASS' || report.failedLayerCount !== 0 || report.executedLayerCount !== 1
    || report.taskResults[0]?.status !== 'EXECUTED' || report.taskResults[0]?.layerId !== SOLVER
    || report.quantumContribution?.status !== 'NOT_APPLICABLE'
    || report.quantumContribution?.problemSha256 !== report.problemSha256) {
    throw new Error(`GAUSS or Quantum rejected the measured linear system: ${JSON.stringify(report.errors)}`);
  }
  const solution = report.taskResults[0].output?.solution;
  if (!Array.isArray(solution) || solution.length !== rhs.length || solution.some((v) => !Number.isFinite(v))) {
    throw new Error('GAUSS returned a malformed solution');
  }
  for (let i = 0; i < matrix.length; i++) {
    const residual = matrix[i].reduce((sum, coefficient, j) => sum + coefficient * solution[j], 0) - rhs[i];
    if (!Number.isFinite(residual) || Math.abs(residual) > 1e-8 * Math.max(1, Math.abs(rhs[i]))) {
      throw new Error('independent linear residual verification failed');
    }
  }
  return Object.freeze({ assurance: 'MEASURED_INPUT_NUMERIC_SOLVE_ONLY', sourceSha256,
    sourceRows: Object.freeze(rates), problemSha256: report.problemSha256,
    gaussReportSha256: report.reportSha256, quantumReceiptSha256: report.quantumContribution.receiptSha256,
    solution: Object.freeze([...solution]), unit: first.unit, dimensions: first.dimensions });
}
