import { describe, expect, test } from "bun:test"
import {
  LMU_THRESHOLDS,
  LmuParseError,
  estimateTrackLengthM,
  normalizeLmuRecording,
  parseRecordingTime,
  sessionInfo,
  unwrapLapDist,
  type LmuRecordingData,
} from "../src/lmu/normalize"
import { buildSyntheticSession, TRACK_LENGTH_M } from "./fixtures/lmu-session"

const session = buildSyntheticSession()
const result = normalizeLmuRecording(session.recording)
const { crossings, lapTimes, splits } = session.expected

describe("normalizeLmuRecording: laps", () => {
  test("drops the out-lap and the cut-off in-lap, numbers laps 1..3", () => {
    expect(result.laps.map((l) => l.lapNumber)).toEqual([1, 2, 3])
    expect(result.laps.map((l) => l.lmuLapCounter)).toEqual([1, 2, 3])
  })

  test("official lap times to the millisecond; invalid lap falls back to the measured time", () => {
    expect(result.laps[0]!.lapTimeSec).toBeCloseTo(lapTimes[0]!, 3)
    expect(result.laps[2]!.lapTimeSec).toBeCloseTo(lapTimes[2]!, 3)
    expect(lapTimes[1]).toBe(0)
    expect(result.laps[1]!.lapTimeSec).toBeCloseTo(crossings[2]! - crossings[1]!, 3)
  })

  test("isClean is false for the invalidated lap only", () => {
    expect(result.laps.map((l) => l.isClean)).toEqual([true, false, true])
    expect(result.laps.every((l) => !l.inPits)).toBe(true)
  })

  test("sectors come from Last Sector1/2 (cumulative) and sum to the lap time", () => {
    const lap1 = result.laps[0]!
    const [c1, c2] = splits[0]!
    expect(lap1.sectorTimes.map((s) => s.sectorNum)).toEqual([1, 2, 3])
    expect(lap1.sectorTimes[0]!.timeSec).toBeCloseTo(c1, 3)
    expect(lap1.sectorTimes[1]!.timeSec).toBeCloseTo(c2 - c1, 3)
    const sum = lap1.sectorTimes.reduce((a, s) => a + s.timeSec, 0)
    expect(sum).toBeCloseTo(lap1.lapTimeSec, 2)
    // Sector distances add up to the lap and sit near 33% / 66% of the layout.
    expect(lap1.sectorTimes[0]!.distanceKm).toBeCloseTo((0.33 * TRACK_LENGTH_M) / 1000, 1)
    const distSum = lap1.sectorTimes.reduce((a, s) => a + s.distanceKm, 0)
    expect(distSum).toBeCloseTo(lap1.distanceKm, 2)
  })

  test("without an official time, sectors fall back to Current Sector changes", () => {
    const lap2 = result.laps[1]!
    const [c1, c2] = splits[1]!
    expect(lap2.sectorTimes).toHaveLength(3)
    expect(Math.abs(lap2.sectorTimes[0]!.timeSec - c1)).toBeLessThan(0.02)
    expect(Math.abs(lap2.sectorTimes[1]!.timeSec - (c2 - c1))).toBeLessThan(0.02)
  })
})

describe("normalizeLmuRecording: distance and track length", () => {
  test("track length from Lap Dist is within one 10 Hz step of the real layout", () => {
    expect(result.session.trackLengthKm).not.toBeNull()
    expect(Math.abs(result.session.trackLengthKm! * 1000 - TRACK_LENGTH_M)).toBeLessThan(8)
  })

  test("every complete lap passes the server's 98% completion gate", () => {
    for (const lap of result.laps) {
      expect(lap.distanceKm / result.session.trackLengthKm!).toBeGreaterThan(0.98)
    }
  })

  test("byDist starts at 0 and is sorted; byTime is time-ordered and starts at 0", () => {
    for (const lap of result.laps) {
      expect(lap.byDist[0]!.distanceKm).toBeCloseTo(0, 2)
      expect(lap.byTime[0]!.timeSec).toBe(0)
      for (let i = 1; i < lap.byDist.length; i++) expect(lap.byDist[i]!.distanceKm).toBeGreaterThanOrEqual(lap.byDist[i - 1]!.distanceKm)
      for (let i = 1; i < lap.byTime.length; i++) expect(lap.byTime[i]!.timeSec).toBeGreaterThan(lap.byTime[i - 1]!.timeSec)
      expect(lap.byTime.at(-1)!.timeSec).toBeCloseTo(lap.lapTimeSec, 1)
    }
  })

  test("downsamples to maxPoints with the telemetry package's stride rule", () => {
    for (const lap of result.laps) {
      expect(lap.points).toBe(lap.byTime.length)
      expect(lap.points).toBeLessThanOrEqual(1000)
      expect(lap.points).toBeGreaterThan(900)
    }
    const small = normalizeLmuRecording(session.recording, { maxPoints: 200 })
    expect(small.laps.every((l) => l.byTime.length <= 200 && l.byDist.length <= 200)).toBe(true)
  })

  test("unwrapLapDist adds one layout per wrap", () => {
    expect(unwrapLapDist([2800, 2890, 5, 100], 2900)).toEqual([2800, 2890, 2905, 3000])
    expect(estimateTrackLengthM([100, 2895, 3, 900, 2899, 1])).toBe(2897)
  })
})

describe("normalizeLmuRecording: channel units and signs", () => {
  const points = result.laps[0]!.byTime

  test("speed, pedals, tyres", () => {
    expect(Math.max(...points.map((p) => p.speedKmh!))).toBeGreaterThan(200)
    expect(points.every((p) => p.throttlePct! >= 0 && p.throttlePct! <= 100)).toBe(true)
    expect(points.some((p) => p.brakePct! > 50)).toBe(true)
    expect(points[0]!.tireTempLF).toBeGreaterThan(79)
    expect(points[0]!.tirePressureRR).toBeCloseTo(173, 0)
    // Tyres Wear is a 0..1 fraction in the file → percent like iRacing bundles.
    expect(points[0]!.tireWearLF).toBeGreaterThan(99)
    expect(points[0]!.tireWearLF).toBeLessThanOrEqual(100)
  })

  test("G Force Long → lateral, G Force Lat → longitudinal with braking negative", () => {
    const braking = points.find((p) => (p.brakePct ?? 0) > 60)!
    expect(braking.longAccelMs2!).toBeLessThan(0)
    const apex = points.reduce((a, p) => ((p.latAccelMs2 ?? 0) > (a.latAccelMs2 ?? 0) ? p : a))
    expect(apex.latAccelMs2!).toBeGreaterThan(15)
  })

  test("steering % (+ right) → nominal degrees with iRacing's sign (+ left)", () => {
    const rec = session.recording.channels["Steering Pos"]!.columns[0]!
    const maxRight = Math.max(...rec)
    const maxDeg = Math.min(...result.laps.flatMap((l) => l.byTime.map((p) => p.steeringDeg!)))
    expect(maxRight).toBeGreaterThan(0)
    expect(maxDeg).toBeLessThan(0)
    expect(Math.abs(maxDeg)).toBeLessThanOrEqual((maxRight / 100) * 270 + 0.01)
  })

  test("gear and ABS come from step events", () => {
    expect(points.every((p) => p.gear != null && p.gear >= 2 && p.gear <= 6)).toBe(true)
    expect(points.some((p) => p.brakeABSactive === true)).toBe(true)
  })

  test("GPS positions are passed through for the track trace", () => {
    expect(points.every((p) => p.lat! > 59 && p.lat! < 61 && p.lon! > 9 && p.lon! < 11)).toBe(true)
  })
})

describe("normalizeLmuRecording: session info", () => {
  test("catalog keys strip the car number", () => {
    expect(result.session).toMatchObject({
      trackName: "Autodromo Sintetico",
      trackLayout: "Short",
      trackKey: "Autodromo Sintetico|Short",
      carName: "Test Hypercar #7",
      carKey: "Test Hypercar",
      carDisplayName: "Test Hypercar",
      carClass: "Hypercar",
      sessionType: "Practice",
      recordingTime: "2026-11-07T18:30:00.000Z",
      driverName: "Test Driver",
    })
  })

  test("RecordingTime parsing", () => {
    expect(parseRecordingTime("2026-10-27T21_05_01Z")).toBe("2026-10-27T21:05:01.000Z")
    expect(parseRecordingTime("garbage")).toBeNull()
    expect(parseRecordingTime(undefined)).toBeNull()
    expect(sessionInfo({}, null)).toMatchObject({ trackName: "Unknown Track", carKey: "Unknown Car", trackLayout: null })
  })
})

describe("normalizeLmuRecording: race start and failures", () => {
  test("race: counter 0 covers formation + lap 1; the timed lap starts lap-time before the line", () => {
    const race = structuredClone(session.recording) as LmuRecordingData
    // LMU does not count up at the end of the formation lap: drop the first
    // crossing's Lap event and time lap 1 against the counter-0 lap.
    race.events.Lap!.rows = race.events.Lap!.rows.filter(([, v]) => v !== 1)
    const lap1 = crossings[1]! - crossings[0]!
    race.events["Lap Time"]!.rows[0] = [crossings[1]!, lap1]
    const out = normalizeLmuRecording(race)
    expect(out.laps[0]!.lmuLapCounter).toBe(0)
    expect(out.laps[0]!.lapNumber).toBe(1)
    expect(out.laps[0]!.lapTimeSec).toBeCloseTo(lap1, 3)
    expect(out.laps[0]!.distanceKm / out.session.trackLengthKm!).toBeGreaterThan(0.98)
    expect(out.laps.map((l) => l.lapNumber)).toEqual([1, 2, 3])
  })

  test("missing GPS Time / Lap Dist / laps throw LmuParseError", () => {
    const noGps = structuredClone(session.recording) as LmuRecordingData
    delete noGps.channels["GPS Time"]
    expect(() => normalizeLmuRecording(noGps)).toThrow(LmuParseError)
    const noDist = structuredClone(session.recording) as LmuRecordingData
    delete noDist.channels["Lap Dist"]
    expect(() => normalizeLmuRecording(noDist)).toThrow(LmuParseError)
    const noLaps = structuredClone(session.recording) as LmuRecordingData
    noLaps.events.Lap!.rows = noLaps.events.Lap!.rows.slice(0, 1)
    expect(() => normalizeLmuRecording(noLaps)).toThrow(LmuParseError)
  })

  test("optional channels disabled in config.json become nulls plus a warning", () => {
    const sparse = structuredClone(session.recording) as LmuRecordingData
    delete sparse.channels.TyresPressure
    delete sparse.channels["Steering Pos"]
    const out = normalizeLmuRecording(sparse)
    expect(out.laps).toHaveLength(3)
    expect(out.warnings).toEqual(expect.arrayContaining(["TyresPressure", "Steering Pos"]))
    expect(out.laps[0]!.byTime[0]!.tirePressureLF).toBeNull()
    expect(out.laps[0]!.byTime[0]!.steeringDeg).toBeNull()
  })
})

describe("normalizeLmuRecording: robustness (review findings)", () => {
  test("a one-sample Lap Dist glitch to 0 doesn't add a lap of distance or move the layout length", () => {
    const glitched = structuredClone(session.recording) as LmuRecordingData
    const dist = glitched.channels["Lap Dist"]!.columns[0]!
    // Mid-lap-1 sample (10 Hz row) drops to 0 for one row.
    const lap1Start = crossings[0]!
    const row = Math.round((lap1Start - session.recording.channels["GPS Time"]!.columns[0]![0]! + 35) * 10)
    expect(dist[row]!).toBeGreaterThan(1000)
    dist[row] = 0
    const out = normalizeLmuRecording(glitched)
    expect(Math.abs(out.session.trackLengthKm! * 1000 - TRACK_LENGTH_M)).toBeLessThan(8)
    for (const lap of out.laps) expect(lap.distanceKm).toBeLessThan(TRACK_LENGTH_M / 1000 + 0.02)
    expect(out.laps.map((l) => l.isClean)).toEqual([true, false, true])
  })

  test("a lap whose distance is far off the layout is not clean", () => {
    const stretched = structuredClone(session.recording) as LmuRecordingData
    const dist = stretched.channels["Lap Dist"]!.columns[0]!
    const t0 = session.recording.channels["GPS Time"]!.columns[0]![0]!
    // Teleport forward 500 m for the rest of lap 3 (sticks, so it is followed).
    const from = Math.round((crossings[2]! - t0 + 30) * 10)
    const to = Math.round((crossings[3]! - t0) * 10)
    for (let i = from; i < to; i++) dist[i] = dist[i]! + 500
    const out = normalizeLmuRecording(stretched)
    expect(out.laps[2]!.isClean).toBe(false)
    expect(out.laps[0]!.isClean).toBe(true)
  })

  test("Lap Time rows written a little after the Lap counter still count as official", () => {
    const late = structuredClone(session.recording) as LmuRecordingData
    for (const name of ["Lap Time", "Last Sector1", "Last Sector2"]) {
      late.events[name]!.rows = late.events[name]!.rows.map(([ts, v]) => [ts + 0.15, v] as [number, number | string])
    }
    const out = normalizeLmuRecording(late)
    expect(out.laps.map((l) => l.isClean)).toEqual([true, false, true])
    expect(out.laps[0]!.lapTimeSec).toBeCloseTo(lapTimes[0]!, 3)
    expect(out.laps[0]!.sectorTimes[0]!.timeSec).toBeCloseTo(splits[0]![0], 3)
  })

  test("a recording switched on mid-lap (counter already >= 1) drops the partial lap", () => {
    const midLap = structuredClone(session.recording) as LmuRecordingData
    // Initial-state row at recording start says "lap 2", then laps continue.
    const t0 = session.recording.channels["GPS Time"]!.columns[0]![0]!
    midLap.events.Lap!.rows = [[t0, 2], ...midLap.events.Lap!.rows.filter(([ts]) => ts > crossings[0]! + 1).map(([ts, v]) => [ts, Number(v) + 1] as [number, number])]
    // That lap really began before the recording: its official time is longer
    // than the window we have.
    const recorded = crossings[1]! - t0
    midLap.events["Lap Time"]!.rows = midLap.events["Lap Time"]!.rows.map(([ts, v], i) => [ts, i === 0 ? recorded + 5 : v] as [number, number | string])
    const out = normalizeLmuRecording(midLap)
    expect(out.laps.find((l) => l.lmuLapCounter === 2)).toBeUndefined()
    expect(out.laps.map((l) => l.lmuLapCounter)).toEqual([3, 4])
    expect(out.laps.every((l) => l.distanceKm / out.session.trackLengthKm! > 0.98)).toBe(true)
  })
})

describe("normalizeLmuRecording: lap verdicts (flags)", () => {
  test("clean laps have no flags and a full completion fraction; the invalidated lap says why", () => {
    expect(result.laps.map((l) => l.flags)).toEqual([[], ["no-lap-last-time"], []])
    for (const lap of result.laps) {
      expect(lap.completed).toBe(true)
      expect(lap.isClean).toBe(lap.flags.length === 0)
      // A fraction, like laps.completion_pct for iRacing (not a percentage).
      expect(lap.completionPct!).toBeGreaterThan(0.99)
      expect(lap.completionPct!).toBeLessThanOrEqual(1.001)
    }
  })

  test("a pit visit during the lap is 'pit-lane'", () => {
    const pitted = structuredClone(session.recording) as LmuRecordingData
    const mid = (crossings[2]! + crossings[3]!) / 2
    pitted.events["In Pits"]!.rows.push([mid, 1], [mid + 5, 0])
    pitted.events["In Pits"]!.rows.sort((a, b) => a[0] - b[0])
    const out = normalizeLmuRecording(pitted)
    expect(out.laps[2]!.flags).toEqual(["pit-lane"])
    expect(out.laps[2]!.isClean).toBe(false)
  })

  test("a lap far over the layout length is 'distance-mismatch'", () => {
    const stretched = structuredClone(session.recording) as LmuRecordingData
    const dist = stretched.channels["Lap Dist"]!.columns[0]!
    const t0 = session.recording.channels["GPS Time"]!.columns[0]![0]!
    const from = Math.round((crossings[2]! - t0 + 30) * 10)
    const to = Math.round((crossings[3]! - t0) * 10)
    for (let i = from; i < to; i++) dist[i] = dist[i]! + 500
    const lap = normalizeLmuRecording(stretched).laps[2]!
    expect(lap.completionPct!).toBeGreaterThan(LMU_THRESHOLDS.MAX_COMPLETION_PCT)
    expect(lap.flags).toContain("distance-mismatch")
  })

  test("an official time implying more than 260 km/h is 'unrealistic-speed'", () => {
    const fast = structuredClone(session.recording) as LmuRecordingData
    // 2.9 km in 30 s = 348 km/h.
    fast.events["Lap Time"]!.rows = fast.events["Lap Time"]!.rows.map(([ts, v], i) => [ts, i === 0 ? 30 : v] as [number, number | string])
    const lap = normalizeLmuRecording(fast).laps[0]!
    expect(lap.lapTimeSec).toBe(30)
    expect(lap.flags).toContain("unrealistic-speed")
  })
})
