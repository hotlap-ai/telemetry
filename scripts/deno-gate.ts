/**
 * Runtime-neutrality gate (RFC-0001 C1): verifies the built ./core,
 * ./normalize and ./lmu artifacts import and run under Deno — the Supabase Edge
 * Function runtime — with no fixtures required.
 *
 * Run after `bun run build`:
 *   deno run scripts/deno-gate.ts
 */
import { IBT } from '../dist/neutral/ibt.js';
import { normalizeIbt, NORMALIZE_THRESHOLDS } from '../dist/neutral/normalize.js';
import { normalizeLmuRecording, packLmuBundle, readLmuBundle, readLmuTables } from '../dist/neutral/lmu.js';
import { buildSyntheticSession } from '../dist/neutral/lmu-testing.js';

// 1. Import gate: the classes/functions exist.
if (typeof IBT?.fromBuffer !== 'function') throw new Error('IBT.fromBuffer missing');
if (typeof normalizeIbt !== 'function') throw new Error('normalizeIbt missing');
if (!NORMALIZE_THRESHOLDS?.MIN_COMPLETION_PCT) throw new Error('thresholds missing');

// 2. Behavior gate: normalize a synthetic source (60 Hz, 1 km track, two full
// laps, no LapLastLapTime channel → crossing-interpolation fallback).
const HZ = 60;
const LAP = 60 * HZ;
const OUT = 30;
const total = OUT + 2 * LAP + 10 * HZ;
const lap = new Int32Array(total);
const time = new Float64Array(total);
const pct = new Float32Array(total);
let i = 0;
for (let k = 0; k < OUT; k++, i++) {
  lap[i] = 0; time[i] = k / HZ; pct[i] = 0.995 + (0.005 * k) / OUT;
}
const t0 = OUT / HZ;
for (let lapNo = 1; lapNo <= 2; lapNo++) {
  for (let k = 0; k < LAP; k++, i++) {
    lap[i] = lapNo; time[i] = t0 + (lapNo - 1) * 60 + k / HZ; pct[i] = k / LAP;
  }
}
for (let k = 0; k < 10 * HZ; k++, i++) {
  lap[i] = 3; time[i] = t0 + 120 + k / HZ; pct[i] = k / LAP;
}
const channels: Record<string, Float64Array | Float32Array | Int32Array> = {
  Lap: lap, SessionTime: time, LapDistPct: pct,
};
const sessions = normalizeIbt({
  tickRate: HZ,
  recordCount: total,
  getAllTyped: (key: string) => channels[key] ?? null,
  getAll: (key: string) => (channels[key] ? Array.from(channels[key]!) : null),
  getSessionInfo: (key?: string) => {
    const root = { WeekendInfo: { EventType: 'Test' } } as Record<string, unknown>;
    return key ? root[key] ?? null : root;
  },
});

const laps = sessions[0]?.laps ?? [];
const l1 = laps.find((l: { lapNumber: number }) => l.lapNumber === 1);
if (!l1?.completed || Math.abs((l1.lapTimeSec ?? 0) - 60) > 0.05) {
  throw new Error(`gate failed: lap 1 = ${JSON.stringify(l1)}`);
}
const l3 = laps.find((l: { lapNumber: number }) => l.lapNumber === 3);
if (l3?.completed !== false || l3?.lapTimeSec !== null) {
  throw new Error(`gate failed: partial lap 3 = ${JSON.stringify(l3)}`);
}
// 3. LMU gate: the synthetic session normalizes to its three timed laps.
if (typeof readLmuTables !== 'function') throw new Error('readLmuTables missing');
const lmu = buildSyntheticSession();
const lmuLaps = normalizeLmuRecording(lmu.recording).laps;
if (lmuLaps.length !== 3 || Math.abs(lmuLaps[0]!.lapTimeSec - lmu.expected.lapTimes[0]!) > 0.001) {
  throw new Error(`gate failed: LMU laps = ${JSON.stringify(lmuLaps.map((l: { lapTimeSec: number }) => l.lapTimeSec))}`);
}

// 4. LMU bundle gate: what the server does — read a bundle, normalize it.
const bundle = packLmuBundle(lmu.recording, { fileName: 'gate.duckdb', sha256: '0'.repeat(64), sizeBytes: 1 });
const fromBundle = normalizeLmuRecording((await readLmuBundle(bundle)).recording).laps;
if (JSON.stringify(fromBundle.map((l: { lapTimeSec: number }) => l.lapTimeSec)) !== JSON.stringify(lmuLaps.map((l: { lapTimeSec: number }) => l.lapTimeSec))) {
  throw new Error('gate failed: LMU bundle laps differ from the recording');
}

console.log('deno-gate OK: core + normalize + lmu (+ bundle) run under Deno; fallback timing verified');
