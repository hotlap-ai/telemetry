import type { LmuRecordingData } from "./normalize"

/**
 * Test helper for consumers (`@hotlap.ai/telemetry/lmu/testing`): a realistic synthetic LMU session, simulated at 100 Hz on a 2.9 km layout
 * (short enough to catch the 3 km default-length bug), with the table shapes
 * LMU writes:
 *
 *   recording starts mid-out-lap (Lap counter 0, no lap time)
 *   lap 1  valid
 *   lap 2  invalidated (Lap Time 0)
 *   lap 3  valid, fastest
 *   lap 4  in-lap: pit entry, recording stops before the line (dropped)
 *
 * Every expected value (crossing times, lap times, sector splits) comes from
 * the simulation itself, so tests can check the normalizer to the millisecond.
 */

export const TRACK_LENGTH_M = 2900
export const MASTER_HZ = 100
export const SESSION_START_TS = 812.4

export interface SyntheticSession {
  recording: LmuRecordingData
  expected: {
    /** Session time of each line crossing (end of out-lap, laps 1..3). */
    crossings: number[]
    /** Official times of laps 1..3 (lap 2 is invalid: LMU writes 0). */
    lapTimes: number[]
    /** Cumulative S1 / S1+S2 splits of laps 1..3. */
    splits: [number, number][]
    validLaps: number[]
  }
}

export interface SimOptions {
  /** Seconds slower per lap, per lap index (1-based); default all equal. */
  lapPace?: Record<number, number>
  /** Timed laps after the out-lap (default 3); one more in-lap is cut off. */
  laps?: number
}

export function buildSyntheticSession(opts: SimOptions = {}): SyntheticSession {
  const dt = 1 / MASTER_HZ
  const L = TRACK_LENGTH_M
  const s1At = 0.33 * L
  const s2At = 0.66 * L

  // Start 700 m before the line on the out-lap.
  let s = L - 700
  let t = SESSION_START_TS
  let lapIndex = 0 // 0 = out-lap
  let sector = 0 // LMU: 1, 2, 0 for S1, S2, S3

  const gpsTime: number[] = []
  const speed: number[] = []
  const throttle: number[] = []
  const brake: number[] = []
  const steering: number[] = []
  const rpm: number[] = []
  const tyreTemp: number[][] = [[], [], [], []]
  const lapDist10: number[] = []
  const lat10: number[] = []
  const lon10: number[] = []
  const gLat10: number[] = []
  const gLong10: number[] = []
  const pressure10: number[][] = [[], [], [], []]
  const wear10: number[][] = [[], [], [], []]
  const throttle50: number[] = []
  const brake50: number[] = []

  const lapEvents: [number, number][] = [[t, 0]]
  const lapTimeEvents: [number, number][] = []
  const s1Events: [number, number][] = []
  const s2Events: [number, number][] = []
  const sectorEvents: [number, number][] = [[t, 0]]
  const gearEvents: [number, number][] = []
  const absEvents: [number, number][] = [[t, 0]]
  const pitEvents: [number, number][] = [[t, 0]]
  const crossings: number[] = []
  const lapTimes: number[] = []
  const splits: [number, number][] = []
  let lapStart = t
  let split1 = 0
  let split2 = 0
  let gear = 0
  let abs = 0
  let inPits = 0
  let sample = 0
  let wear = 1

  const lastLap = (opts.laps ?? 3) + 1
  const pace = (lap: number) => 1 + (opts.lapPace?.[lap] ?? (lap === 3 ? -0.01 : 0))

  while (true) {
    // Speed profile: three corners per lap, 95..235 km/h.
    const phase = (s / L) * Math.PI * 2 * 3
    const kmh = (165 + 70 * Math.cos(phase)) / pace(lapIndex)
    const corner = Math.max(0, -Math.cos(phase)) // 0 straight .. 1 apex
    const dist = (kmh / 3.6) * dt
    const prevS = s
    s += dist
    t += dt
    sample++

    // Line crossing.
    if (s >= L) {
      const frac = (L - prevS) / dist
      const ts = t - dt + frac * dt
      s -= L
      crossings.push(ts)
      if (lapIndex >= 1) {
        const time = ts - lapStart
        const official = lapIndex === 2 ? 0 : time
        lapTimes.push(round3(official))
        lapTimeEvents.push([ts, round3(official)])
        s1Events.push([ts, round3(split1)])
        s2Events.push([ts, round3(split2)])
        splits.push([round3(split1), round3(split2)])
      }
      lapIndex++
      lapStart = ts
      lapEvents.push([ts, lapIndex])
      sectorEvents.push([ts, 1])
      sector = 1
    }
    if (lapIndex >= 1 && sector === 1 && s >= s1At) {
      split1 = t - lapStart
      sectorEvents.push([t, 2])
      sector = 2
    }
    if (lapIndex >= 1 && sector === 2 && s >= s2At) {
      split2 = t - lapStart
      sectorEvents.push([t, 0])
      sector = 0
    }
    // Lap 4: pit entry 400 m before the line, recording stops 100 m later.
    if (lapIndex === lastLap && !inPits && s >= L - 400) {
      inPits = 1
      pitEvents.push([t, 1])
    }
    if (lapIndex === lastLap && s >= L - 300) break

    const nextGear = Math.min(6, Math.max(2, Math.round(kmh / 40)))
    if (nextGear !== gear) {
      gear = nextGear
      gearEvents.push([t, gear])
    }
    const braking = corner > 0.6 ? Math.min(100, (corner - 0.6) * 250) : 0
    const nextAbs = braking > 80 ? 1 : 0
    if (nextAbs !== abs) {
      abs = nextAbs
      absEvents.push([t, abs])
    }

    gpsTime.push(t)
    speed.push(kmh)
    throttle.push(braking > 0 ? 0 : 100 - corner * 60)
    brake.push(braking)
    steering.push(30 * corner * Math.sign(Math.sin(phase / 2) || 1)) // % of lock, + right
    rpm.push(4000 + (kmh % 40) * 150)
    for (let w = 0; w < 4; w++) tyreTemp[w]!.push(80 + w + corner * 10)
    // Row k of a lower-rate channel is master sample k * (100 / f).
    if ((sample - 1) % 2 === 0) {
      throttle50.push(throttle.at(-1)!)
      brake50.push(braking)
    }
    if ((sample - 1) % 10 === 0) {
      const angle = (s / L) * Math.PI * 2
      lapDist10.push(s)
      lat10.push(60 + 0.004 * Math.sin(angle))
      lon10.push(10 + 0.008 * Math.cos(angle))
      gLong10.push(2 * corner) // LMU "G Force Long" = lateral g
      gLat10.push(braking / 40) // LMU "G Force Lat" = longitudinal g, + braking
      wear -= 0.00001
      for (let w = 0; w < 4; w++) {
        pressure10[w]!.push(170 + w)
        wear10[w]!.push(wear)
      }
    }
  }

  const channels: LmuRecordingData["channels"] = {
    "GPS Time": ch(100, "s", [gpsTime]),
    "Ground Speed": ch(100, "km/h", [speed]),
    "Throttle Pos": ch(50, "%", [throttle50]),
    "Brake Pos": ch(50, "%", [brake50]),
    "Steering Pos": ch(100, "%", [steering]),
    "Engine RPM": ch(100, "rpm", [rpm]),
    "Lap Dist": ch(10, "m", [lapDist10]),
    "GPS Latitude": ch(10, "deg", [lat10]),
    "GPS Longitude": ch(10, "deg", [lon10]),
    "G Force Long": ch(10, "g", [gLong10]),
    "G Force Lat": ch(10, "g", [gLat10]),
    TyresTempCentre: ch(100, "C", tyreTemp),
    TyresPressure: ch(10, "kPa", pressure10),
    "Tyres Wear": ch(10, "", wear10),
  }
  const events: LmuRecordingData["events"] = {
    Lap: ev("", lapEvents),
    "Lap Time": ev("s", lapTimeEvents),
    "Last Sector1": ev("s", s1Events),
    "Last Sector2": ev("s", s2Events),
    "Current Sector": ev("", sectorEvents),
    Gear: ev("", gearEvents),
    ABS: ev("", absEvents),
    "In Pits": ev("", pitEvents),
  }

  return {
    recording: {
      metadata: {
        Version: "1",
        DriverName: "Test Driver",
        RecordingTime: "2026-11-07T18_30_00Z",
        SessionTime: String(SESSION_START_TS),
        SessionType: "Practice",
        TrackName: "Autodromo Sintetico",
        TrackLayout: "Short",
        CarName: "Test Hypercar #7",
        CarClass: "Hypercar",
        WeatherConditions: "Clear",
      },
      channels,
      events,
    },
    expected: {
      crossings,
      lapTimes,
      splits,
      validLaps: [1, 3],
    },
  }
}

function ch(frequency: number, unit: string, columns: number[][]) {
  return {
    frequency,
    unit,
    columnNames: columns.length === 1 ? ["value"] : columns.map((_, i) => `value${i + 1}`),
    columns,
  }
}

function ev(unit: string, rows: [number, number][]) {
  return { unit, rows }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
