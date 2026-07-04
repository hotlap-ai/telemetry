/**
 * Canonical lap point extraction — produces the per-sample telemetry series
 * (byDist / byTime) that the UI charts and the backend lap_bundles store.
 *
 * Output shape matches the deployed IbtLapPoint contract exactly
 * (UI/src/lib/ibt-extract.ts and BACKEND process-job convertToIbtLapData):
 *  - Speed m/s → km/h, Throttle/Brake 0–1 → 0–100 %, SteeringWheelAngle rad → deg
 *  - distanceKm normalized per lap: (LapDist − min LapDist) / 1000
 *  - timeSec normalized per lap: SessionTime − min SessionTime
 *  - tire temps LFtempM.. with LFtempCM.. carcass fallback (process-job behavior)
 *
 * CANONICAL DECISION — tire wear is percent 0–100 (×100 from the raw 0–1
 * channel), matching process-job and therefore every stored lap bundle. The
 * UI's ibt-extract.ts left wear at raw 0–1; that was the divergent one.
 *
 * RFC-0001 C8: extraction runs at FULL resolution; downsampling to maxPoints
 * happens last and is presentation-only — never an input to metrics.
 *
 * RUNTIME NEUTRALITY: this module must not import Bun/Deno/Node APIs.
 */

import type { IbtSource, NormalizedLap } from './normalize';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** Matches the UI/backend IbtLapPoint contract field-for-field. */
export interface LapPoint {
  distanceKm: number;
  timeSec: number;
  speedKmh: number | null;
  throttlePct: number | null;
  brakePct: number | null;
  brakeABSactive: boolean | null;
  gear: number | null;
  rpm: number | null;
  steeringDeg: number | null;
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  tireTempLF: number | null;
  tireTempRF: number | null;
  tireTempLR: number | null;
  tireTempRR: number | null;
  tirePressureLF: number | null;
  tirePressureRF: number | null;
  tirePressureLR: number | null;
  tirePressureRR: number | null;
  tireWearLF: number | null;
  tireWearRF: number | null;
  tireWearLR: number | null;
  tireWearRR: number | null;
}

export interface ExtractLapPointsResult {
  /** Points sorted ascending by distanceKm (downsampled). */
  byDist: LapPoint[];
  /** Points sorted ascending by timeSec (downsampled). */
  byTime: LapPoint[];
  /** Number of valid full-resolution points before downsampling. */
  downsampledFrom: number;
}

export interface ExtractLapPointsOptions {
  /** Maximum points per series after downsampling. Default 500. */
  maxPoints?: number;
}

const DEFAULT_MAX_POINTS = 500;

// ---------------------------------------------------------------------------
// Channel access helpers (channels may come back typed or as unknown[])
// ---------------------------------------------------------------------------

type Channel = ArrayLike<unknown>;

/** Prefer the typed fast path; fall back to getAll (bool channels, etc.). */
function channel(source: IbtSource, key: string): Channel | null {
  const typed = source.getAllTyped(key);
  if (typed) return typed;
  return source.getAll(key);
}

/** First available channel of several candidates (e.g. LFtempM → LFtempCM). */
function channelWithFallback(source: IbtSource, ...keys: string[]): Channel | null {
  for (const key of keys) {
    const c = channel(source, key);
    if (c) return c;
  }
  return null;
}

function readNum(arr: Channel | null, i: number): number | null {
  if (!arr) return null;
  const v = arr[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** BrakeABSactive: bool channel, but tolerate 0/1 numerics (UI reference). */
function readBool(arr: Channel | null, i: number): boolean | null {
  if (!arr) return null;
  const v = arr[i];
  if (typeof v === 'boolean') return v;
  if (v === 1) return true;
  if (v === 0) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Extract the telemetry point series for one normalized lap.
 *
 * Iterates lap.firstSampleIndex..lastSampleIndex; when the Lap / SessionNum
 * channels are available, only indices whose Lap equals lap.lapNumber (and
 * whose SessionNum matches the lap's own session, read at firstSampleIndex)
 * are honored. Without those channels the whole contiguous range is accepted.
 */
export function extractLapPoints(
  source: IbtSource,
  lap: NormalizedLap,
  opts?: ExtractLapPointsOptions
): ExtractLapPointsResult {
  const maxPoints = Math.max(1, Math.floor(opts?.maxPoints ?? DEFAULT_MAX_POINTS));

  const timeArr = channel(source, 'SessionTime');
  const distArr = channel(source, 'LapDist');
  // SessionTime + LapDist are required by the point contract (both references
  // skip samples missing either; with no channel at all there are no points).
  if (!timeArr || !distArr || source.recordCount === 0) {
    return { byDist: [], byTime: [], downsampledFrom: 0 };
  }

  const lapArr = channel(source, 'Lap');
  const sessArr = channel(source, 'SessionNum');

  const speedArr = channel(source, 'Speed');
  const throttleArr = channel(source, 'Throttle');
  const brakeArr = channel(source, 'Brake');
  const absArr = channel(source, 'BrakeABSactive');
  const gearArr = channel(source, 'Gear');
  const rpmArr = channel(source, 'RPM');
  const steerArr = channel(source, 'SteeringWheelAngle');
  const latArr = channel(source, 'Lat');
  const lonArr = channel(source, 'Lon');
  const altArr = channel(source, 'Alt');

  // Surface temp first, carcass fallback — process-job behavior.
  const tempLF = channelWithFallback(source, 'LFtempM', 'LFtempCM');
  const tempRF = channelWithFallback(source, 'RFtempM', 'RFtempCM');
  const tempLR = channelWithFallback(source, 'LRtempM', 'LRtempCM');
  const tempRR = channelWithFallback(source, 'RRtempM', 'RRtempCM');
  const pressLF = channel(source, 'LFpressure');
  const pressRF = channel(source, 'RFpressure');
  const pressLR = channel(source, 'LRpressure');
  const pressRR = channel(source, 'RRpressure');
  const wearLF = channel(source, 'LFwearM');
  const wearRF = channel(source, 'RFwearM');
  const wearLR = channel(source, 'LRwearM');
  const wearRR = channel(source, 'RRwearM');

  // --- select this lap's sample indices ------------------------------------
  const first = Math.max(0, lap.firstSampleIndex);
  const last = Math.min(source.recordCount - 1, lap.lastSampleIndex);
  const expectedSess = readNum(sessArr, first);

  const indices: number[] = [];
  for (let i = first; i <= last; i++) {
    if (lapArr) {
      const l = readNum(lapArr, i);
      if (l != null && l !== lap.lapNumber) continue;
    }
    if (sessArr && expectedSess != null) {
      const s = readNum(sessArr, i);
      if (s != null && s !== expectedSess) continue;
    }
    indices.push(i);
  }

  // --- per-lap normalization baselines (full resolution) -------------------
  let minTime = Infinity;
  let minDist = Infinity;
  for (const i of indices) {
    const t = readNum(timeArr, i);
    const d = readNum(distArr, i);
    if (t == null || d == null) continue;
    if (t < minTime) minTime = t;
    if (d < minDist) minDist = d;
  }
  if (!Number.isFinite(minTime) || !Number.isFinite(minDist)) {
    return { byDist: [], byTime: [], downsampledFrom: 0 };
  }

  // --- build full-resolution points -----------------------------------------
  const points: LapPoint[] = [];
  for (const i of indices) {
    const t = readNum(timeArr, i);
    const d = readNum(distArr, i);
    if (t == null || d == null) continue;

    const speed = readNum(speedArr, i);
    const throttle = readNum(throttleArr, i);
    const brake = readNum(brakeArr, i);
    const steerRad = readNum(steerArr, i);
    const wLF = readNum(wearLF, i);
    const wRF = readNum(wearRF, i);
    const wLR = readNum(wearLR, i);
    const wRR = readNum(wearRR, i);

    points.push({
      distanceKm: (d - minDist) / 1000, // meters → km, per-lap min normalized
      timeSec: t - minTime,
      speedKmh: speed != null ? speed * 3.6 : null, // m/s → km/h
      throttlePct: throttle != null ? throttle * 100 : null, // 0–1 → %
      brakePct: brake != null ? brake * 100 : null, // 0–1 → %
      brakeABSactive: readBool(absArr, i),
      gear: readNum(gearArr, i),
      rpm: readNum(rpmArr, i),
      steeringDeg: steerRad != null ? (steerRad * 180) / Math.PI : null, // rad → deg
      lat: readNum(latArr, i),
      lon: readNum(lonArr, i),
      altitudeM: readNum(altArr, i),
      tireTempLF: readNum(tempLF, i),
      tireTempRF: readNum(tempRF, i),
      tireTempLR: readNum(tempLR, i),
      tireTempRR: readNum(tempRR, i),
      tirePressureLF: readNum(pressLF, i),
      tirePressureRF: readNum(pressRF, i),
      tirePressureLR: readNum(pressLR, i),
      tirePressureRR: readNum(pressRR, i),
      // CANONICAL: wear is percent 0–100 (raw channel is 0–1), matching
      // process-job and every stored lap bundle. The UI's ibt-extract.ts
      // kept the raw 0–1 value — that was the divergent implementation.
      tireWearLF: wLF != null ? wLF * 100 : null,
      tireWearRF: wRF != null ? wRF * 100 : null,
      tireWearLR: wLR != null ? wLR * 100 : null,
      tireWearRR: wRR != null ? wRR * 100 : null,
    });
  }

  // --- validity filter (both references) ------------------------------------
  const valid = points.filter(
    (p) =>
      Number.isFinite(p.distanceKm) &&
      Number.isFinite(p.timeSec) &&
      p.distanceKm >= 0 &&
      p.timeSec >= 0
  );

  // --- sort, then downsample last (RFC C8: presentation only) ---------------
  const byDistFull = [...valid].sort((a, b) => a.distanceKm - b.distanceKm);
  const byTimeFull = [...valid].sort((a, b) => a.timeSec - b.timeSec);

  // DEVIATION from the references' stride formula: they used
  // floor(len/maxPoints), which OVERSHOOTS the cap (e.g. 6230 samples →
  // stride 12 → 520 points; 999 samples → stride 1 → 999 points). ceil
  // guarantees ≤ maxPoints while keeping the same i % stride === 0 selection,
  // applied to the dist- and time-sorted arrays independently (process-job
  // behavior) so index 0 — the true min of each ordering — is always kept.
  const stride = Math.max(1, Math.ceil(valid.length / maxPoints));
  const byDist = stride > 1 ? byDistFull.filter((_, i) => i % stride === 0) : byDistFull;
  const byTime = stride > 1 ? byTimeFull.filter((_, i) => i % stride === 0) : byTimeFull;

  return { byDist, byTime, downsampledFrom: valid.length };
}
