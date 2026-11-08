import type { LapPoint } from "../lap-points"
import type { LapFlag } from "../normalize"

/**
 * Le Mans Ultimate recording → HotLap.ai laps.
 *
 * Pure mapping from the tables `readLmuTables()` returns (no DuckDB, no I/O)
 * to the same `LapPoint` series the iRacing extractor produces, so uploads,
 * lap bundles, charts and AI coaching consume LMU laps unchanged.
 *
 * File format (LMU >= 1.2, observed and cross-checked against independent
 * parsers; see README.md "Le Mans Ultimate"):
 *  - Fixed-rate channels have no timestamp column. `GPS Time` (100 Hz) holds
 *    the session time of each master sample; a channel at f Hz lines up with
 *    master sample i at row i * f / f_master.
 *  - Events are sparse `(ts, value)` rows written on change, `ts` = session
 *    time in seconds.
 *  - Four-wheel tables are `value1..value4` = FL, FR, RL, RR.
 *  - Laps run from one `Lap` event to the next. The official time is the
 *    `Lap Time` event at the finish; 0 / missing = invalid. Counter 0 is the
 *    out-lap in practice, and formation + first lap in a race.
 *  - `Last Sector1` / `Last Sector2` at the finish are cumulative splits;
 *    `Current Sector` changes (2 = S2 start, 0 = S3 start) are the fallback.
 *  - `Lap Dist` (m) wraps to 0 at the line.
 *  - `G Force Long` holds LATERAL g (+ = left turn) and `G Force Lat` holds
 *    LONGITUDINAL g (+ = braking): LMU's labels are swapped.
 *  - `Steering Pos` is % of lock, + = right. There is no steering-lock
 *    channel, so it is shown on a nominal ±270° scale (a 540° wheel), with
 *    iRacing's sign (+ = left). Analysis thresholds are relative to each
 *    corner's maximum, so the nominal scale does not bias them.
 *
 * Channel and event names are looked up dynamically; anything optional that
 * is missing (users can disable channels in UserData/Telemetry/config.json)
 * becomes null in the points.
 */

/** A numeric column: plain arrays from a DuckDB host, typed arrays from a bundle. */
export type LmuNumberColumn = ArrayLike<number>

export interface LmuChannelData {
  frequency: number
  unit: string
  columnNames: string[]
  columns: LmuNumberColumn[]
}

export interface LmuEventData {
  unit: string
  rows: [ts: number, value: number | string][]
}

export interface LmuRecordingData {
  metadata: Record<string, string>
  channels: Record<string, LmuChannelData>
  events: Record<string, LmuEventData>
}

export interface LmuSessionInfo {
  trackName: string
  /** LMU layout name (e.g. "Circuit de la Sarthe"), or null when absent. */
  trackLayout: string | null
  /** Stable catalog key: "<TrackName>|<TrackLayout>". */
  trackKey: string
  /** As recorded, including the car number ("Ferrari 499P #50"). */
  carName: string
  /** Car without the trailing "#NN" number; the catalog key. */
  carKey: string
  carDisplayName: string
  carClass: string | null
  sessionType: string | null
  /** ISO 8601, or null when RecordingTime is missing or unparseable. */
  recordingTime: string | null
  driverName: string | null
  /** Median completed-lap length from Lap Dist, in km. */
  trackLengthKm: number | null
}

export interface LmuSectorTime {
  sectorNum: number
  timeSec: number
  /** Length of this sector in km (0 when it could not be located). */
  distanceKm: number
}

export interface LmuLap {
  /** Points sorted by distance from the line (downsampled). */
  byDist: LapPoint[]
  /** Points in time order (downsampled). */
  byTime: LapPoint[]
  /** Strictly increasing within a recording (LMU's counter can repeat). */
  lapNumber: number
  /** LMU's official lap time when present, else the measured window. */
  lapTimeSec: number
  distanceKm: number
  points: number
  sectorTimes: LmuSectorTime[]
  /** Always 0: an LMU recording holds one session. */
  sessionNum: number
  sessionType?: string
  /** Always true: a lap is only emitted once both line crossings are recorded. */
  completed: boolean
  /** Lap Dist covered / layout length, as a fraction (null when the length is unknown). */
  completionPct: number | null
  /** Why the lap is not clean; empty for a clean lap. Same vocabulary as normalizeIbt. */
  flags: LapFlag[]
  /** No flags: official time, no pit visit, full length, realistic speed. */
  isClean: boolean
  /** LMU's own lap counter at the start of the lap. */
  lmuLapCounter: number
  /** Car entered the pit lane during the lap (in-lap / out-lap). */
  inPits: boolean
}

export interface NormalizeOptions {
  /** Points per series after downsampling. Default 1000. */
  maxPoints?: number
}

export interface NormalizedLmuRecording {
  session: LmuSessionInfo
  laps: LmuLap[]
  /** Optional channels that were missing or unusable. */
  warnings: string[]
}

export class LmuParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LmuParseError"
  }
}

const G = 9.80665
const NOMINAL_STEERING_HALF_RANGE_DEG = 270
/** Event ts and the master timeline agree to well under one 100 Hz sample. */
const EVENT_MATCH_TOLERANCE_S = 0.1
/**
 * `Lap Time` / `Last Sector*` rows are matched to the lap's finish within this
 * window (or up to the next Lap event, whichever is sooner). There is one row
 * per lap, so a wide window costs nothing and survives a logger that writes
 * them a tick or two after the counter.
 */
export const LAP_EVENT_WINDOW_BEFORE_S = 0.5
export const LAP_EVENT_WINDOW_AFTER_S = 5
/** A lap whose measured window disagrees with LMU's own time by more is re-anchored on the official time. */
const OFFICIAL_TIME_MISMATCH_S = 1
/** A lap this far off the layout length is not clean (Lap Dist glitch, teleport, cut). */
const LAP_LENGTH_TOLERANCE = 0.05
const MIN_LAP_POINTS = 10

/** Lap verdict thresholds (the iRacing equivalents live in NORMALIZE_THRESHOLDS). */
export const LMU_THRESHOLDS = {
  /** Below this fraction of the layout length: 'low-completion'. */
  MIN_COMPLETION_PCT: 0.98,
  /** Above this fraction (Lap Dist glitch, teleport, cut): 'distance-mismatch'. */
  MAX_COMPLETION_PCT: 1 + LAP_LENGTH_TOLERANCE,
  /** Average speed above this: 'unrealistic-speed' (Le Mans Hypercar is about 240). */
  MAX_AVG_SPEED_KMH: 260,
} as const
const DEFAULT_MAX_POINTS = 1000

/** The only tables the normalizer reads; pass these to readLmuTables to skip the rest. */
export const LMU_CHANNELS_USED = [
  "GPS Time",
  "Ground Speed",
  "Lap Dist",
  "Throttle Pos",
  "Brake Pos",
  "Steering Pos",
  "Engine RPM",
  "GPS Latitude",
  "GPS Longitude",
  "G Force Long",
  "G Force Lat",
  "TyresTempCentre",
  "TyresPressure",
  "Tyres Wear",
] as const

export const LMU_EVENTS_USED = [
  "Lap",
  "Lap Time",
  "Last Sector1",
  "Last Sector2",
  "Current Sector",
  "Gear",
  "ABS",
  "In Pits",
] as const

/**
 * Laps one at a time, for hosts that store each lap as it is produced instead
 * of holding a whole race in memory (a server inside a 256 MB isolate).
 * `session` is complete up front, except that `trackLengthKm` is filled in
 * after the last lap when the recording has no line-crossing peaks to measure
 * the layout from. Errors about the recording as a whole throw immediately.
 */
export interface LmuRecordingStream {
  session: LmuSessionInfo
  /** Optional channels that were missing or unusable. */
  warnings: string[]
  laps: Generator<LmuLap, void, undefined>
}

export function normalizeLmuRecording(rec: LmuRecordingData, options: NormalizeOptions = {}): NormalizedLmuRecording {
  const stream = streamLmuRecording(rec, options)
  const laps = [...stream.laps]
  return { session: stream.session, laps, warnings: stream.warnings }
}

export function streamLmuRecording(rec: LmuRecordingData, options: NormalizeOptions = {}): LmuRecordingStream {
  const maxPoints = Math.max(MIN_LAP_POINTS, Math.floor(options.maxPoints ?? DEFAULT_MAX_POINTS))
  const warnings: string[] = []

  const gps = rec.channels["GPS Time"]
  const gpsTimes = gps?.columns[0]
  if (!gps || !gpsTimes || gpsTimes.length < 2 || !(gps.frequency > 0)) {
    throw new LmuParseError('Recording has no "GPS Time" channel; it is needed to line telemetry up with laps.')
  }
  const masterHz = gps.frequency
  const times = gpsTimes
  const masterCount = times.length

  const lapDistChannel = rec.channels["Lap Dist"]
  if (!lapDistChannel?.columns[0]?.length) {
    throw new LmuParseError('Recording has no "Lap Dist" channel.')
  }
  const lapEvents = sortedEvents(rec, "Lap")
  if (lapEvents.length < 2) {
    throw new LmuParseError("Recording has no completed laps.")
  }

  const channel = (name: string, column = 0, required = false): Sampler | null => {
    const ch = rec.channels[name]
    const values = ch?.columns[column]
    if (!ch || !values || values.length === 0 || !(ch.frequency > 0)) {
      if (required) throw new LmuParseError(`Recording has no "${name}" channel.`)
      if (!warnings.includes(name)) warnings.push(name)
      return null
    }
    return new Sampler(values, ch.frequency / masterHz)
  }

  // Lap Dist → continuous distance (unwrapped across the line).
  const lapDistRaw = lapDistChannel.columns[0]
  const lapDistRatio = lapDistChannel.frequency / masterHz
  // Layout length from the peaks reached before each wrap; this, not any one
  // lap, is what the server stores for the layout.
  const trackLengthM = estimateTrackLengthM(lapDistRaw)
  const lapDist = new Sampler(unwrapLapDist(lapDistRaw, trackLengthM), lapDistRatio)

  const speedUnit = rec.channels["Ground Speed"]?.unit ?? ""
  const speed = channel("Ground Speed", 0, true)!
  const toKmh = /m\/s/i.test(speedUnit) ? 3.6 : 1
  const throttle = percentChannel(rec, "Throttle Pos", channel)
  const brake = percentChannel(rec, "Brake Pos", channel)
  const steering = percentChannel(rec, "Steering Pos", channel)
  const rpm = channel("Engine RPM")
  const latitude = channel("GPS Latitude")
  const longitude = channel("GPS Longitude")
  const lateralG = channel("G Force Long") // swapped labels, see header
  const longitudinalG = channel("G Force Lat")
  const tyreTemp = wheelChannels(rec, "TyresTempCentre", channel)
  const tempOffset = /^k|kelvin/i.test(rec.channels.TyresTempCentre?.unit ?? "") ? -273.15 : 0
  const tyrePressure = wheelChannels(rec, "TyresPressure", channel)
  const pressureScale = pressureToKpa(rec.channels.TyresPressure?.unit ?? "")
  const tyreWear = wheelChannels(rec, "Tyres Wear", channel)
  const wearScale = percentScale(rec.channels["Tyres Wear"])

  const gearEvents = sortedEvents(rec, "Gear")
  const absEvents = sortedEvents(rec, "ABS")
  const pitEvents = sortedEvents(rec, "In Pits")
  const lapTimeEvents = sortedEvents(rec, "Lap Time")
  const s1Events = sortedEvents(rec, "Last Sector1")
  const s2Events = sortedEvents(rec, "Last Sector2")
  const sectorEvents = sortedEvents(rec, "Current Sector")
  if (gearEvents.length === 0) warnings.push("Gear")

  const recordingEnd = times[masterCount - 1]!
  const session = sessionInfo(rec.metadata, trackLengthM != null ? trackLengthM / 1000 : null)

  function* laps(): Generator<LmuLap, void, undefined> {
    const completedLengthsM: number[] = []
    let lastLapNumber = 0

    for (let k = 0; k < lapEvents.length - 1; k++) {
      const counter = lapEvents[k]!
      const finish = lapEvents[k + 1]!
      if (finish.ts > recordingEnd + EVENT_MATCH_TOLERANCE_S) continue // cut off at the end

      const nextLapTs = lapEvents[k + 2]?.ts ?? Infinity
      const atFinish = (events: TimedValue[]) => valueAtFinish(events, finish.ts, nextLapTs)
      const official = atFinish(lapTimeEvents)
      const counterValue = Math.round(counter.value)
      // Out-lap (practice, counter 0): no official time, skipped.
      if (counterValue === 0 && !(official > 0)) continue
      let startTs = counter.ts
      if (official > 0 && Math.abs(finish.ts - counter.ts - official) > OFFICIAL_TIME_MISMATCH_S) {
        // The Lap row isn't where the lap started: counter 0 in a race also
        // covers the formation lap, and a recording switched on mid-lap starts
        // with an initial-state row. LMU's own time says where it began.
        startTs = finish.ts - official
      }
      if (startTs < times[0]! - EVENT_MATCH_TOLERANCE_S) continue // began before the recording

      const startIdx = lowerBound(times, startTs)
      const endIdx = Math.min(masterCount - 1, upperBound(times, finish.ts) - 1)
      if (endIdx - startIdx + 1 < MIN_LAP_POINTS) continue

      const inPits = stepValue(pitEvents, startTs + 0.01) > 0 || pitEvents.some((e) => e.value > 0 && e.ts > startTs && e.ts < finish.ts)
      const lapTimeSec = official > 0 ? official : finish.ts - startTs
      if (!(lapTimeSec > 0)) continue

      // Full-resolution points over the master timeline.
      const startTime = times[startIdx]!
      let minDist = Infinity
      let maxDist = -Infinity
      const full: LapPoint[] = []
      const gearCursor = new EventCursor(gearEvents)
      const absCursor = new EventCursor(absEvents)
      for (let i = startIdx; i <= endIdx; i++) {
        const t = times[i]!
        const d = lapDist.at(i)
        if (d == null || !Number.isFinite(t)) continue
        if (d < minDist) minDist = d
        if (d > maxDist) maxDist = d
        const steer = steering?.sampler.at(i) ?? null
        const latG = lateralG?.at(i) ?? null
        const lonG = longitudinalG?.at(i) ?? null
        const kmh = speed.at(i)
        full.push({
          distanceKm: d, // metres for now; normalized below
          timeSec: t - startTime,
          speedKmh: kmh != null ? kmh * toKmh : null,
          throttlePct: throttle ? scaled(throttle.sampler.at(i), throttle.scale) : null,
          brakePct: brake ? scaled(brake.sampler.at(i), brake.scale) : null,
          brakeABSactive: absEvents.length ? absCursor.valueAt(t) > 0 : null,
          gear: gearEvents.length ? Math.round(gearCursor.valueAt(t)) : null,
          rpm: rpm?.at(i) ?? null,
          // % of lock, + right → nominal degrees, + left (iRacing convention).
          steeringDeg: steer != null && steering ? -(steer * steering.scale / 100) * NOMINAL_STEERING_HALF_RANGE_DEG : null,
          lat: latitude?.at(i) ?? null,
          lon: longitude?.at(i) ?? null,
          altitudeM: null,
          latAccelMs2: latG != null ? latG * G : null,
          longAccelMs2: lonG != null ? -lonG * G : null,
          yawRateDegS: null,
          tireTempLF: offset(tyreTemp[0]?.at(i), tempOffset),
          tireTempRF: offset(tyreTemp[1]?.at(i), tempOffset),
          tireTempLR: offset(tyreTemp[2]?.at(i), tempOffset),
          tireTempRR: offset(tyreTemp[3]?.at(i), tempOffset),
          tirePressureLF: scaled(tyrePressure[0]?.at(i) ?? null, pressureScale),
          tirePressureRF: scaled(tyrePressure[1]?.at(i) ?? null, pressureScale),
          tirePressureLR: scaled(tyrePressure[2]?.at(i) ?? null, pressureScale),
          tirePressureRR: scaled(tyrePressure[3]?.at(i) ?? null, pressureScale),
          tireWearLF: scaled(tyreWear[0]?.at(i) ?? null, wearScale),
          tireWearRF: scaled(tyreWear[1]?.at(i) ?? null, wearScale),
          tireWearLR: scaled(tyreWear[2]?.at(i) ?? null, wearScale),
          tireWearRR: scaled(tyreWear[3]?.at(i) ?? null, wearScale),
        })
      }
      if (full.length < MIN_LAP_POINTS || !Number.isFinite(minDist)) continue
      for (const p of full) p.distanceKm = (p.distanceKm - minDist) / 1000
      const distanceKm = (maxDist - minDist) / 1000

      const sectorTimes = lapSectors({
        official,
        startTs,
        finishTs: finish.ts,
        s1: atFinish(s1Events),
        s2: atFinish(s2Events),
        sectorEvents,
        distanceAt: (ts) => {
          const idx = Math.min(endIdx, Math.max(startIdx, lowerBound(times, ts)))
          const d = lapDist.at(idx)
          return d == null ? null : (d - minDist) / 1000
        },
        distanceKm,
      })

      const lapNumber = Math.max(lastLapNumber + 1, counterValue >= 1 ? counterValue : 1)
      lastLapNumber = lapNumber
      const lengthM = maxDist - minDist
      const lengthOk = trackLengthM == null || Math.abs(lengthM - trackLengthM) <= trackLengthM * LAP_LENGTH_TOLERANCE
      const completionPct = trackLengthM != null && trackLengthM > 0 ? round(lengthM / trackLengthM, 4) : null
      const flags: LapFlag[] = []
      if (!(official > 0)) flags.push("no-lap-last-time")
      if (inPits) flags.push("pit-lane")
      if (completionPct != null && completionPct < LMU_THRESHOLDS.MIN_COMPLETION_PCT) flags.push("low-completion")
      if (completionPct != null && completionPct > LMU_THRESHOLDS.MAX_COMPLETION_PCT) flags.push("distance-mismatch")
      const avgKmh = ((trackLengthM ?? lengthM) / 1000 / lapTimeSec) * 3600
      if (avgKmh > LMU_THRESHOLDS.MAX_AVG_SPEED_KMH) flags.push("unrealistic-speed")
      const isClean = flags.length === 0
      if (official > 0 && !inPits && lengthOk) completedLengthsM.push(lengthM)

      const byDist = downsample([...full].sort((a, b) => a.distanceKm - b.distanceKm), maxPoints)
      const byTime = downsample(full, maxPoints) // already in time order
      yield {
        byDist,
        byTime,
        lapNumber,
        lapTimeSec,
        distanceKm,
        points: byTime.length,
        sectorTimes,
        sessionNum: 0,
        sessionType: rec.metadata.SessionType || undefined,
        completed: true,
        completionPct,
        flags,
        isClean,
        lmuLapCounter: counterValue,
        inPits,
      }
    }

    // Peaks first (set up front): one odd lap must never set the layout length.
    if (session.trackLengthKm == null) {
      const lengthFromLaps = median(completedLengthsM)
      if (lengthFromLaps != null) session.trackLengthKm = round(lengthFromLaps / 1000, 4)
    }
  }

  return { session, warnings, laps: laps() }
}

// ---------------------------------------------------------------------------
// Session metadata

export function sessionInfo(metadata: Record<string, string>, trackLengthKm: number | null): LmuSessionInfo {
  const trackName = clean(metadata.TrackName) || "Unknown Track"
  const trackLayout = clean(metadata.TrackLayout) || null
  const carName = clean(metadata.CarName) || "Unknown Car"
  const carKey = carName.replace(/\s+#\d+\s*$/, "").trim() || carName
  return {
    trackName,
    trackLayout,
    trackKey: `${trackName}|${trackLayout ?? ""}`,
    carName,
    carKey,
    carDisplayName: carKey,
    carClass: clean(metadata.CarClass) || null,
    sessionType: clean(metadata.SessionType) || null,
    recordingTime: parseRecordingTime(metadata.RecordingTime),
    driverName: clean(metadata.DriverName) || null,
    trackLengthKm: trackLengthKm != null && trackLengthKm > 0 ? round(trackLengthKm, 4) : null,
  }
}

/** "2026-10-27T21_05_01Z" (LMU) → "2026-10-27T21:05:01.000Z". */
export function parseRecordingTime(value: string | undefined): string | null {
  const text = clean(value)
  if (!text) return null
  const normalized = text.replace(/T(\d{2})_(\d{2})_(\d{2})/, "T$1:$2:$3")
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// ---------------------------------------------------------------------------
// Sectors

interface SectorInput {
  official: number
  startTs: number
  finishTs: number
  s1: number
  s2: number
  sectorEvents: TimedValue[]
  distanceAt: (ts: number) => number | null
  distanceKm: number
}

function lapSectors(input: SectorInput): LmuSectorTime[] {
  const { official, startTs, finishTs, s1, s2, sectorEvents, distanceAt, distanceKm } = input
  let boundaries: [number, number] | null = null
  let durations: [number, number, number] | null = null

  if (official > 0 && s1 > 0 && s2 > s1 && official > s2) {
    durations = [s1, s2 - s1, official - s2]
    boundaries = [startTs + s1, startTs + s2]
  } else {
    const inside = sectorEvents.filter((e) => e.ts > startTs + 0.05 && e.ts < finishTs - 0.05)
    const s2Start = inside.find((e) => Math.round(e.value) === 2)?.ts
    const s3Start = inside.find((e) => Math.round(e.value) === 0)?.ts
    if (s2Start != null && s3Start != null && s3Start > s2Start) {
      durations = [s2Start - startTs, s3Start - s2Start, finishTs - s3Start]
      boundaries = [s2Start, s3Start]
    }
  }
  if (!durations || !boundaries) return []

  const d1 = distanceAt(boundaries[0])
  const d2 = distanceAt(boundaries[1])
  if (d1 == null || d2 == null || !(d2 > d1)) {
    return durations.map((timeSec, i) => ({ sectorNum: i + 1, timeSec: round(timeSec, 3), distanceKm: 0 }))
  }
  return [
    { sectorNum: 1, timeSec: round(durations[0], 3), distanceKm: round(d1, 4) },
    { sectorNum: 2, timeSec: round(durations[1], 3), distanceKm: round(d2 - d1, 4) },
    { sectorNum: 3, timeSec: round(durations[2], 3), distanceKm: round(Math.max(0, distanceKm - d2), 4) },
  ]
}

// ---------------------------------------------------------------------------
// Distance

/**
 * Track length from the raw Lap Dist samples: the median of the peaks reached
 * just before each wrap, else the overall maximum. A drop only counts as a
 * wrap when the value stays low for the following sample too, so a
 * one-sample glitch to 0 is not mistaken for a line crossing.
 */
export function estimateTrackLengthM(values: LmuNumberColumn): number | null {
  const peaks: number[] = []
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (!Number.isFinite(v)) continue
    if (v > max) max = v
    if (!(v > 0)) continue
    const next = nextFinite(values, i + 1)
    if (next == null || !(v - next.value > v / 2)) continue
    const after = nextFinite(values, next.index + 1)
    if (after == null || after.value < v / 2) peaks.push(v)
  }
  if (!Number.isFinite(max) || max <= 0) return null
  return median(peaks) ?? max
}

/**
 * Continuous distance: adds a track length at every wrap back to ~0.
 *
 * A jump of more than half a layout that comes straight back (one bad
 * sample) is dropped instead of shifting everything after it by a lap; a jump
 * that sticks is a wrap (downwards) or a reposition (upwards, e.g. reset to
 * the pits) and is followed.
 */
export function unwrapLapDist(values: LmuNumberColumn, trackLengthM: number | null): number[] {
  const out = new Array<number>(values.length)
  const half = trackLengthM ? trackLengthM / 2 : null
  let offset = 0
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (!Number.isFinite(v)) {
      out[i] = Number.NaN
      continue
    }
    if (prev != null && half != null && trackLengthM && Math.abs(v - prev) > half) {
      const next = nextFinite(values, i + 1)
      if (next && Math.abs(next.value - prev) <= half) {
        out[i] = Number.NaN // glitch: the next sample is back where we were
        continue
      }
      if (v < prev) offset += trackLengthM
    }
    out[i] = v + offset
    prev = v
  }
  return out
}

function nextFinite(values: LmuNumberColumn, from: number): { index: number; value: number } | null {
  for (let i = from; i < values.length; i++) {
    const v = values[i]!
    if (Number.isFinite(v)) return { index: i, value: v }
  }
  return null
}

// ---------------------------------------------------------------------------
// Sampling helpers

/** Linear interpolation of a fixed-rate channel at master sample index i. */
class Sampler {
  constructor(private readonly values: LmuNumberColumn, private readonly ratio: number) {}

  at(masterIndex: number): number | null {
    const pos = masterIndex * this.ratio
    const last = this.values.length - 1
    if (last < 0) return null
    if (pos <= 0) return finite(this.values[0])
    if (pos >= last) return finite(this.values[last])
    const i = Math.floor(pos)
    const a = this.values[i]!
    const b = this.values[i + 1]!
    if (!Number.isFinite(a)) return finite(b)
    if (!Number.isFinite(b)) return a
    return a + (b - a) * (pos - i)
  }
}

interface TimedValue {
  ts: number
  value: number
}

/** Step lookup over sorted events, advancing monotonically (O(n) per lap). */
class EventCursor {
  private index = -1
  constructor(private readonly events: TimedValue[]) {}

  valueAt(t: number): number {
    while (this.index + 1 < this.events.length && this.events[this.index + 1]!.ts <= t) this.index++
    return this.index >= 0 ? this.events[this.index]!.value : 0
  }
}

function sortedEvents(rec: LmuRecordingData, name: string): TimedValue[] {
  const rows = rec.events[name]?.rows ?? []
  const out: TimedValue[] = []
  for (const [ts, raw] of rows) {
    const value = typeof raw === "number" ? raw : Number(raw)
    if (Number.isFinite(ts) && Number.isFinite(value)) out.push({ ts, value })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

function stepValue(events: TimedValue[], t: number): number {
  let value = 0
  for (const e of events) {
    if (e.ts > t) break
    value = e.value
  }
  return value
}

/**
 * The per-lap event row (Lap Time, Last Sector1/2) belonging to the lap that
 * finished at `finishTs`: the row closest to it within
 * [finish - 0.5 s, min(next Lap event, finish + 5 s)), else 0.
 */
function valueAtFinish(events: TimedValue[], finishTs: number, nextLapTs: number): number {
  const lo = finishTs - LAP_EVENT_WINDOW_BEFORE_S
  const hi = Math.min(nextLapTs, finishTs + LAP_EVENT_WINDOW_AFTER_S)
  let best: TimedValue | null = null
  for (const e of events) {
    if (e.ts < lo || e.ts >= hi) continue
    if (!best || Math.abs(e.ts - finishTs) < Math.abs(best.ts - finishTs)) best = e
  }
  return best?.value ?? 0
}

function percentChannel(
  rec: LmuRecordingData,
  name: string,
  channel: (name: string) => Sampler | null,
): { sampler: Sampler; scale: number } | null {
  const sampler = channel(name)
  return sampler ? { sampler, scale: percentScale(rec.channels[name]) } : null
}

/** 1 for channels already in percent, 100 for 0..1 fractions. */
function percentScale(ch: LmuChannelData | undefined): number {
  if (!ch) return 1
  if (ch.unit.includes("%")) return 1
  let maxAbs = 0
  for (const col of ch.columns) {
    for (let i = 0; i < col.length; i++) {
      const v = col[i]!
      if (Number.isFinite(v) && Math.abs(v) > maxAbs) maxAbs = Math.abs(v)
    }
  }
  return maxAbs <= 1.0001 ? 100 : 1
}

function wheelChannels(rec: LmuRecordingData, name: string, channel: (name: string, column?: number) => Sampler | null): (Sampler | null)[] {
  const ch = rec.channels[name]
  if (!ch || ch.columns.length < 4) {
    channel(name) // records the warning
    return [null, null, null, null]
  }
  return [0, 1, 2, 3].map((c) => channel(name, c))
}

function pressureToKpa(unit: string): number {
  if (/psi/i.test(unit)) return 6.894757
  if (/^bar$/i.test(unit.trim())) return 100
  return 1
}

function scaled(v: number | null, scale: number): number | null {
  return v == null ? null : v * scale
}

function offset(v: number | null | undefined, delta: number): number | null {
  return v == null ? null : v + delta
}

function finite(v: number | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null
}

/** First index with arr[i] >= x (arr ascending). */
function lowerBound(arr: LmuNumberColumn, x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index with arr[i] > x (arr ascending). */
function upperBound(arr: LmuNumberColumn, x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Same stride rule as extractLapPoints (ceil: never above maxPoints). */
function downsample<T>(points: T[], maxPoints: number): T[] {
  const stride = Math.max(1, Math.ceil(points.length / maxPoints))
  return stride > 1 ? points.filter((_, i) => i % stride === 0) : points
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function clean(v: string | undefined): string {
  return (v ?? "").trim()
}
