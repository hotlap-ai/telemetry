/**
 * Canonical telemetry normalization — the single source of truth for what a
 * lap IS across HotLap.ai (UI, Edge Functions, CLI).
 *
 * Implements RFC-0001 (hotlap.ai repo, docs/rfcs/RFC-0001-canonical-telemetry-parser.md):
 *  - C2: official lap time from the sim's LapLastLapTime channel, with
 *        crossing-interpolation fallback. Sample striding is never an input.
 *  - C3: a lap is `completed` only when the sim scored it.
 *  - C4: sectors computed at full resolution, numbered 1..N (iRacing S1..SN),
 *        no silent rescaling — the residual is reported instead.
 *  - C5: session metadata resolved via the SessionNum channel against the
 *        YAML Sessions list; multi-session files split per session.
 *  - C7: classify, don't drop — every observed lap appears with flags.
 *
 * RUNTIME NEUTRALITY: this module must not import Bun/Deno/Node APIs.
 * It consumes an already-parsed IBT source (see IbtSource).
 */

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/** Structural subset of the IBT class this module needs (keeps it testable). */
export interface IbtSource {
  readonly tickRate: number;
  readonly recordCount: number;
  getAllTyped(key: string): Float32Array | Float64Array | Int32Array | Uint32Array | null;
  getAll(key: string): unknown[] | null;
  getSessionInfo<T = unknown>(key?: string): T | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type LapFlag =
  | 'out-lap'              // lap 0: pit exit to first line crossing, never a full lap
  | 'no-lap-last-time'     // sim never scored this lap; time (if any) is derived
  | 'low-completion'       // covered < MIN_COMPLETION_PCT of track length
  | 'incident-delta'       // incident count increased during the lap
  | 'unrealistic-speed'    // avg speed above MAX_AVG_SPEED_KMH (teleport/reset)
  | 'too-few-samples'      // fewer than MIN_SAMPLES telemetry samples
  | 'no-sector-data';      // one or more sector boundary crossings unobservable

export type TimingSource =
  | 'lap-last-lap-time'    // authoritative: sim clock
  | 'crossing-interpolation' // derived from LapDistPct wrap at full resolution
  | 'sample-span';         // last resort: max-min SessionTime (diagnostic quality)

export interface NormalizedSector {
  /** 1-based, matches iRacing S1/S2/S3 display convention. */
  sectorNum: number;
  timeSec: number | null;
}

export interface NormalizedLap {
  lapNumber: number;
  completed: boolean;
  /** Official lap time (null when the lap was never completed/scored and no fallback exists). */
  lapTimeSec: number | null;
  timingSource: TimingSource | null;
  /** Diagnostic: max−min SessionTime within the lap. Never the official time. */
  sampleSpanSec: number;
  distanceKm: number;
  completionPct: number | null;
  sectorTimes: NormalizedSector[];
  /** lapTimeSec − Σ sectors; ≈0 when timing and sectors agree. Null without both. */
  sectorResidualSec: number | null;
  incidents: number;
  flags: LapFlag[];
  sampleCount: number;
  /** First/last record indices of this lap in the file (for consumers extracting points). */
  firstSampleIndex: number;
  lastSampleIndex: number;
}

export interface NormalizedSession {
  sessionNum: number;
  /** Sessions[sessionNum].SessionType — full string, e.g. "Offline Testing", "Lone Qualify". */
  sessionType: string | null;
  sessionName: string | null;
  /** WeekendInfo.EventType — event-level context, distinct from sessionType. */
  eventType: string | null;
  trackId: number | null;
  trackName: string | null;
  trackConfigName: string | null;
  trackLengthKm: number | null;
  seriesId: number | null;
  seasonId: number | null;
  sessionId: number | null;
  subSessionId: number | null;
  driverCarIdx: number;
  driverName: string | null;
  carId: number | null;
  carScreenName: string | null;
  carPath: string | null;
  tickRate: number;
  laps: NormalizedLap[];
}

// ---------------------------------------------------------------------------
// Thresholds (RFC C7) — exported so storage policy and tests share one source.
// ---------------------------------------------------------------------------

export const NORMALIZE_THRESHOLDS = {
  MIN_SAMPLES: 10,
  MIN_COMPLETION_PCT: 0.9,
  MAX_AVG_SPEED_KMH: 220,
  /**
   * LapLastLapTime updates shortly after the line crossing. If the recording
   * contains fewer than this many seconds of lap N+1, a missing update means
   * "recording ended before the sim published the time", not "unscored lap".
   */
  LLT_UPDATE_GRACE_SEC: 2,
} as const;

// ---------------------------------------------------------------------------
// YAML metadata helpers (typed loosely — iRacing YAML shape varies by build)
// ---------------------------------------------------------------------------

interface YamlRoot {
  WeekendInfo?: Record<string, unknown>;
  DriverInfo?: { DriverCarIdx?: number; Drivers?: Array<Record<string, unknown>> };
  SplitTimeInfo?: { Sectors?: Array<{ SectorNum?: number; SectorStartPct?: number }> };
  SessionInfo?: { Sessions?: Array<Record<string, unknown>> };
}

function parseTrackLengthKm(weekend: Record<string, unknown> | undefined): number | null {
  const raw = (weekend?.TrackLength ?? weekend?.TrackLengthOfficial) as string | undefined;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/([\d.]+)\s*km/i);
  if (!m) return null;
  const km = parseFloat(m[1]!);
  return Number.isFinite(km) && km > 0 ? km : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

interface LapAccumulator {
  lapNumber: number;
  indices: number[]; // sample indices, in file (time) order
}

/**
 * Normalize a parsed .ibt file into one NormalizedSession per SessionNum
 * observed in the channel data (RFC C5).
 */
export function normalizeIbt(source: IbtSource): NormalizedSession[] {
  const n = source.recordCount;

  const lapArr = source.getAllTyped('Lap');
  const timeArr = source.getAllTyped('SessionTime');
  const distArr = source.getAllTyped('LapDist');       // meters
  const pctArr = source.getAllTyped('LapDistPct');     // 0..1
  const lltArr = source.getAllTyped('LapLastLapTime'); // seconds; lap N's time visible during N+1
  const sessArr = source.getAllTyped('SessionNum');
  const incArr = source.getAllTyped('PlayerCarMyIncidentCount');

  if (!lapArr || !timeArr || n === 0) return [];

  const yaml = (source.getSessionInfo() ?? {}) as YamlRoot;
  const weekend = yaml.WeekendInfo;
  const trackLengthKm = parseTrackLengthKm(weekend);
  const boundaries = sectorBoundaries(yaml);
  const meta = driverMeta(yaml);

  // Partition sample indices by (sessionNum, lapNumber), preserving order.
  const sessions = new Map<number, Map<number, LapAccumulator>>();
  for (let i = 0; i < n; i++) {
    const lap = lapArr[i] as number;
    const sess = sessArr ? (sessArr[i] as number) : 0;
    if (!Number.isFinite(lap)) continue;
    let lapsOfSession = sessions.get(sess);
    if (!lapsOfSession) sessions.set(sess, (lapsOfSession = new Map()));
    let acc = lapsOfSession.get(lap);
    if (!acc) lapsOfSession.set(lap, (acc = { lapNumber: lap, indices: [] }));
    acc.indices.push(i);
  }

  const out: NormalizedSession[] = [];
  for (const [sessionNum, lapsOfSession] of [...sessions.entries()].sort((a, b) => a[0] - b[0])) {
    const sessionEntry = yaml.SessionInfo?.Sessions?.find(
      (s) => num(s.SessionNum) === sessionNum
    );

    const laps: NormalizedLap[] = [];
    const lapNumbers = [...lapsOfSession.keys()].sort((a, b) => a - b);
    for (const lapNumber of lapNumbers) {
      const acc = lapsOfSession.get(lapNumber)!;
      const next = lapsOfSession.get(lapNumber + 1);
      laps.push(
        normalizeLap(acc, next, {
          timeArr, distArr, pctArr, lltArr, incArr,
          trackLengthKm,
          boundaries,
        })
      );
    }

    out.push({
      sessionNum,
      sessionType: str(sessionEntry?.SessionType),
      sessionName: str(sessionEntry?.SessionName),
      eventType: str(weekend?.EventType),
      trackId: num(weekend?.TrackID),
      trackName: str(weekend?.TrackDisplayName) ?? str(weekend?.TrackName),
      trackConfigName: str(weekend?.TrackConfigName),
      trackLengthKm,
      seriesId: num(weekend?.SeriesID),
      seasonId: num(weekend?.SeasonID),
      sessionId: num(weekend?.SessionID),
      subSessionId: num(weekend?.SubSessionID),
      driverCarIdx: meta.driverCarIdx,
      driverName: meta.driverName,
      carId: meta.carId,
      carScreenName: meta.carScreenName,
      carPath: meta.carPath,
      tickRate: source.tickRate,
      laps,
    });
  }
  return out;
}

function driverMeta(yaml: YamlRoot): {
  driverCarIdx: number;
  driverName: string | null;
  carId: number | null;
  carScreenName: string | null;
  carPath: string | null;
} {
  const driverCarIdx = num(yaml.DriverInfo?.DriverCarIdx) ?? 0;
  const driver = yaml.DriverInfo?.Drivers?.find((d) => num(d.CarIdx) === driverCarIdx);
  return {
    driverCarIdx,
    driverName: str(driver?.UserName),
    carId: num(driver?.CarID),
    carScreenName: str(driver?.CarScreenName),
    carPath: str(driver?.CarPath),
  };
}

/** SplitTimeInfo boundaries sorted by pct; guaranteed to start at 0. */
function sectorBoundaries(yaml: YamlRoot): number[] {
  const sectors = yaml.SplitTimeInfo?.Sectors;
  if (!Array.isArray(sectors) || sectors.length === 0) return [];
  const pcts = sectors
    .map((s) => num(s.SectorStartPct))
    .filter((p): p is number => p != null && p >= 0 && p < 1)
    .sort((a, b) => a - b);
  if (pcts.length === 0) return [];
  if (pcts[0]! !== 0) pcts.unshift(0);
  return pcts;
}

interface LapContext {
  timeArr: ArrayLike<number>;
  distArr: ArrayLike<number> | null;
  pctArr: ArrayLike<number> | null;
  lltArr: ArrayLike<number> | null;
  incArr: ArrayLike<number> | null;
  trackLengthKm: number | null;
  boundaries: number[];
}

function normalizeLap(
  acc: LapAccumulator,
  next: LapAccumulator | undefined,
  ctx: LapContext
): NormalizedLap {
  const { timeArr, distArr, pctArr, lltArr, incArr, trackLengthKm, boundaries } = ctx;
  const idx = acc.indices;
  const flags: LapFlag[] = [];
  const isOutLap = acc.lapNumber === 0;
  if (isOutLap) flags.push('out-lap');

  // --- sample span & distance (diagnostics + completion) --------------------
  let minT = Infinity, maxT = -Infinity, minD = Infinity, maxD = -Infinity;
  for (const i of idx) {
    const t = timeArr[i]!;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (distArr) {
      const d = distArr[i]!;
      if (Number.isFinite(d)) {
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
      }
    }
  }
  const sampleSpanSec = maxT - minT;
  const distanceKm = distArr && maxD > minD ? (maxD - minD) / 1000 : 0;
  const completionPct =
    trackLengthKm && trackLengthKm > 0 ? distanceKm / trackLengthKm : null;

  if (idx.length < NORMALIZE_THRESHOLDS.MIN_SAMPLES) flags.push('too-few-samples');
  if (completionPct != null && completionPct < NORMALIZE_THRESHOLDS.MIN_COMPLETION_PCT) {
    flags.push('low-completion');
  }

  // --- official lap time (RFC C2) -------------------------------------------
  // LapLastLapTime during lap N reports lap N−1's scored time. So lap N's time
  // becomes visible during lap N+1. Detect the update: last value in N+1 that
  // is > 0 and differs from the value that was current during lap N.
  let lapTimeSec: number | null = null;
  let timingSource: TimingSource | null = null;

  if (lltArr && next && next.indices.length > 0 && !isOutLap) {
    const lltDuringLap = lastFinite(lltArr, idx);
    let updated: number | null = null;
    for (const i of next.indices) {
      const v = lltArr[i]!;
      if (v > 0 && (lltDuringLap == null || Math.abs(v - lltDuringLap) > 1e-9)) updated = v;
    }
    // Same-time edge case: if the sim value never changed but is positive and
    // plausibly this lap's (within 2× the sample span), we cannot distinguish
    // an update from a stale value — treat unchanged as NOT scored.
    if (updated != null) {
      lapTimeSec = updated;
      timingSource = 'lap-last-lap-time';
    }
  }

  // Fallback (RFC C2): crossing interpolation applies when the sim's verdict
  // is UNAVAILABLE rather than negative — the LapLastLapTime channel is absent
  // entirely, or the recording stopped inside the post-crossing update lag
  // (< LLT_UPDATE_GRACE_SEC of lap N+1 captured). When the channel exists and
  // had time to update but didn't, the sim did not score the lap (reset/tow/
  // ghost) — a validity verdict, so no time is derived.
  let completed = timingSource === 'lap-last-lap-time';
  if (lapTimeSec == null && !isOutLap) {
    flags.push('no-lap-last-time');
    const nextSpanSec =
      next && next.indices.length > 0
        ? timeArr[next.indices[next.indices.length - 1]!]! - timeArr[next.indices[0]!]!
        : null;
    const updateMissed =
      lltArr != null &&
      nextSpanSec != null &&
      nextSpanSec < NORMALIZE_THRESHOLDS.LLT_UPDATE_GRACE_SEC;
    if (!lltArr || updateMissed) {
      const start = crossingStart(acc, ctx);
      const finish = crossingFinish(acc, next, ctx);
      if (start != null && finish != null && finish > start) {
        lapTimeSec = finish - start;
        timingSource = 'crossing-interpolation';
        // Without the sim's verdict, completion falls back to measured
        // coverage (distance vs track length, or raw LapDistPct span).
        completed = coverageComplete(acc, ctx, completionPct);
      }
    }
  }

  // --- average-speed sanity (only meaningful with a time) -------------------
  const effectiveTime = lapTimeSec ?? (sampleSpanSec > 0 ? sampleSpanSec : null);
  if (effectiveTime && distanceKm > 0) {
    const avgKmh = distanceKm / (effectiveTime / 3600);
    if (avgKmh > NORMALIZE_THRESHOLDS.MAX_AVG_SPEED_KMH) flags.push('unrealistic-speed');
  }

  // --- incidents -------------------------------------------------------------
  let incidents = 0;
  if (incArr && idx.length >= 2) {
    const first = firstFinite(incArr, idx);
    const last = lastFinite(incArr, idx);
    if (first != null && last != null) incidents = Math.max(0, last - first);
  }
  if (incidents > 0) flags.push('incident-delta');

  // --- sectors (RFC C4): SessionTime interpolated at boundary crossings -----
  const sectorTimes = computeSectors(acc, next, ctx);
  if (sectorTimes.some((s) => s.timeSec == null) && sectorTimes.length > 0) {
    flags.push('no-sector-data');
  }
  let sectorResidualSec: number | null = null;
  if (lapTimeSec != null && sectorTimes.length > 0 && sectorTimes.every((s) => s.timeSec != null)) {
    const sum = sectorTimes.reduce((a, s) => a + (s.timeSec ?? 0), 0);
    sectorResidualSec = lapTimeSec - sum;
  }

  return {
    lapNumber: acc.lapNumber,
    completed,
    lapTimeSec,
    timingSource,
    sampleSpanSec,
    distanceKm,
    completionPct,
    sectorTimes,
    sectorResidualSec,
    incidents,
    flags,
    sampleCount: idx.length,
    firstSampleIndex: idx[0]!,
    lastSampleIndex: idx[idx.length - 1]!,
  };
}

/**
 * Sector k (1-based) spans boundary k−1 → boundary k; the final sector spans
 * the last boundary → the finish-line crossing (start of lap N+1).
 * All times interpolated from LapDistPct/SessionTime at full resolution.
 */
function computeSectors(
  acc: LapAccumulator,
  next: LapAccumulator | undefined,
  ctx: LapContext
): NormalizedSector[] {
  const { boundaries, timeArr } = ctx;
  if (boundaries.length === 0 || acc.lapNumber === 0) return [];

  // Position series: prefer LapDistPct; else derive pct from LapDist/trackLength.
  const pctAt = (i: number): number | null => pctAtIndex(i, ctx);

  // Boundary crossing times within this lap (boundary 0 = lap start crossing,
  // approximated by the first observed sample only for the residual-free path;
  // sector deltas below only use boundaries 1.. and the finish crossing).
  const crossing = (targetPct: number): number | null => {
    let prevI: number | null = null;
    for (const i of acc.indices) {
      const p = pctAt(i);
      if (p == null) continue;
      if (prevI != null) {
        const p0 = pctAt(prevI)!;
        if (p0 <= targetPct && p >= targetPct && p >= p0) {
          const t0 = timeArr[prevI]!;
          const t1 = timeArr[i]!;
          if (p === p0) return t0;
          return t0 + ((targetPct - p0) / (p - p0)) * (t1 - t0);
        }
      }
      prevI = i;
    }
    return null;
  };

  const startT = crossingStart(acc, ctx) ?? timeArr[acc.indices[0]!]!;
  const times: Array<number | null> = [];
  for (let b = 1; b < boundaries.length; b++) {
    times.push(crossing(boundaries[b]!));
  }
  times.push(crossingFinish(acc, next, ctx));

  const sectors: NormalizedSector[] = [];
  let prevT: number | null = startT;
  for (let k = 0; k < times.length; k++) {
    const t = times[k];
    sectors.push({
      sectorNum: k + 1,
      timeSec: t != null && prevT != null ? t - prevT : null,
    });
    if (t != null) prevT = t;
  }
  return sectors;
}

/** Start-of-lap crossing: interpolate the wrap out of the previous lap when observable. */
function crossingStart(acc: LapAccumulator, ctx: LapContext): number | null {
  const { timeArr } = ctx;
  const firstI = acc.indices[0]!;
  if (firstI === 0) return null;
  const prevI = firstI - 1;
  const p0 = pctAtIndex(prevI, ctx);
  const p1 = pctAtIndex(firstI, ctx);
  if (p0 == null || p1 == null) return null;
  const t0 = timeArr[prevI]!;
  const t1 = timeArr[firstI]!;
  if (p0 > p1) {
    // wrap: previous sample was near 1.0, first sample of this lap near 0
    const step = 1 - p0 + p1;
    if (step <= 0) return (t0 + t1) / 2;
    return t0 + ((1 - p0) / step) * (t1 - t0);
  }
  // No wrap observed (recording starts mid-lap, tow, session change): there is
  // no genuine line crossing here. Callers needing an approximation (sector
  // deltas) fall back to the first-sample time themselves; timing must not.
  return null;
}

/** RFC C3 coverage check when the sim's verdict is unavailable. */
function coverageComplete(
  acc: LapAccumulator,
  ctx: LapContext,
  completionPct: number | null
): boolean {
  if (completionPct != null) {
    return completionPct >= NORMALIZE_THRESHOLDS.MIN_COMPLETION_PCT;
  }
  // No track length: measure coverage from the LapDistPct span directly.
  let minP = Infinity;
  let maxP = -Infinity;
  for (const i of acc.indices) {
    const p = pctAtIndex(i, ctx);
    if (p == null) continue;
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  return maxP > minP && maxP - minP >= NORMALIZE_THRESHOLDS.MIN_COMPLETION_PCT;
}

/** Finish-line crossing: interpolate across the pct wrap into the next lap. */
function crossingFinish(
  acc: LapAccumulator,
  next: LapAccumulator | undefined,
  ctx: LapContext
): number | null {
  if (!next || next.indices.length === 0) return null;
  const { timeArr } = ctx;
  const lastI = acc.indices[acc.indices.length - 1]!;
  const firstNext = next.indices[0]!;
  const p0 = pctAtIndex(lastI, ctx);
  const p1 = pctAtIndex(firstNext, ctx);
  if (p0 == null || p1 == null) return null;
  const t0 = timeArr[lastI]!;
  const t1 = timeArr[firstNext]!;
  // p wraps: e.g. 0.998 → 0.002. Distance to the line: (1 − p0); total step: (1 − p0) + p1.
  const step = 1 - p0 + p1;
  if (step <= 0) return (t0 + t1) / 2;
  return t0 + ((1 - p0) / step) * (t1 - t0);
}

function pctAtIndex(i: number, ctx: LapContext): number | null {
  if (ctx.pctArr) {
    const p = ctx.pctArr[i]!;
    return Number.isFinite(p) && p >= 0 ? p : null;
  }
  if (ctx.distArr && ctx.trackLengthKm && ctx.trackLengthKm > 0) {
    const d = ctx.distArr[i]!;
    return Number.isFinite(d) ? d / (ctx.trackLengthKm * 1000) : null;
  }
  return null;
}

function firstFinite(arr: ArrayLike<number>, indices: number[]): number | null {
  for (const i of indices) {
    const v = arr[i]!;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function lastFinite(arr: ArrayLike<number>, indices: number[]): number | null {
  for (let k = indices.length - 1; k >= 0; k--) {
    const v = arr[indices[k]!]!;
    if (Number.isFinite(v)) return v;
  }
  return null;
}
