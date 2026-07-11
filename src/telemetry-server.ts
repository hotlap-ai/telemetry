#!/usr/bin/env bun

import { createIRSDK } from './live'
import type { WeekendInfo, DriverInfo, Driver, SessionInfoData } from './types'

const TELEMETRY_PORT = 32100
const TELEMETRY_RATE_HZ = 60
const SESSION_INFO_RATE_HZ = 1
// Multi-car field snapshot every Nth tick (60Hz / 4 = 15Hz).
const FIELD_PUBLISH_EVERY = 4

// Bumped when the message set changes. Clients read it from /health to detect
// a stale server instance holding the port and POST /shutdown to replace it.
// v3: sessionFlags + carLeftRight in the 60Hz frame (delta/flags/radar overlays).
const PROTOCOL_VERSION = 3

// The UI fetches /health and /status cross-origin (vite dev origin or
// tauri.localhost); without these headers browsers block the response.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export interface SessionInfoMessage {
  type: 'session_info'
  data: {
    trackId: number
    trackName: string
    trackDisplayName: string
    trackLength: string
    trackConfig: string
    carId: number
    carName: string
    carNumber: string
    driverName: string
    driverId: number
    sessionType: string
    sessionNum: number
    tickRate: number
    sectors: Array<{ sectorNum: number; startPct: number }>
  }
}

export interface TelemetryMessage {
  type: 'telemetry'
  data: TelemetryFrame
}

export interface TelemetryFrame {
  tick: number
  sessionTime: number
  lap: number
  lapDistPct: number
  speed: number
  rpm: number
  gear: number
  throttle: number
  brake: number
  clutch: number
  steer: number
  lat: number
  lon: number
  alt: number
  yaw: number
  pitch: number
  roll: number
  lapCurrentLapTime: number
  lapLastLapTime: number
  lapBestLapTime: number
  lapDeltaToBestLap: number
  fuelLevel: number
  fuelLevelPct: number
  oilTemp: number
  waterTemp: number
  isOnTrack: boolean
  playerPosition: number
  playerClassPosition: number
  brakeABSactive: boolean
  dcBrakeBias: number
  dcTractionControl: number
  dcABS: number
  tireTempLF: number
  tireTempRF: number
  tireTempLR: number
  tireTempRR: number
  tirePressureLF: number | null
  tirePressureRF: number | null
  tirePressureLR: number | null
  tirePressureRR: number | null
  tireWearLF: number | null
  tireWearRF: number | null
  tireWearLR: number | null
  tireWearRR: number | null
  sessionNum: number
  onPitRoad: boolean
  playerCarIdx: number
  /** All cars' lap-distance pct at this tick (4dp) — head-to-head sector
   * timing needs the full 60Hz stream, not the 15Hz field snapshot. */
  carIdxLapDistPct: number[]
  /** irsdk_Flags bitfield (green/yellow/blue/white/checkered...). */
  sessionFlags: number
  /** irsdk_CarLeftRight spotter enum: 1 clear, 2 left, 3 right, 4 both, 5 two left, 6 two right. */
  carLeftRight: number
}

export interface LapChangeMessage {
  type: 'lap_change'
  data: {
    fromLap: number
    toLap: number
    lapTime: number
    sessionNum: number
  }
}

export interface StatusMessage {
  type: 'status'
  data: {
    connected: boolean
    initialized: boolean
    error?: string
  }
}

export interface FieldMessage {
  type: 'field'
  data: FieldData
}

/** Live multi-car snapshot, published at ~15Hz. Parallel arrays indexed by CarIdx. */
export interface FieldData {
  tick: number
  sessionTime: number
  sessionNum: number
  sessionState: number
  sessionTimeRemain: number
  sessionLapsRemain: number
  playerCarIdx: number
  paceCarIdx: number
  position: number[]
  classPosition: number[]
  lap: number[]
  lapCompleted: number[]
  lapDistPct: number[]
  estTime: number[]
  f2Time: number[]
  onPitRoad: boolean[]
  trackSurface: number[]
  lastLapTime: number[]
  bestLapTime: number[]
}

export interface OverlayDriver {
  carIdx: number
  userName: string
  teamName?: string
  carNumber: string
  carClassId: number
  carClassShortName: string
  carClassColor: number
  carClassRelSpeed: number
  carClassEstLapTime: number
  iRating: number
  licString: string
  licColor: number
  incidentCount: number
}

export interface ClassInfo {
  classId: number
  shortName: string
  color: number
  sof: number
  carCount: number
}

export interface SessionStateMessage {
  type: 'session_state'
  data: SessionStateData
}

/** Roster + results snapshot, published when iRacing bumps its session-info counter. */
export interface SessionStateData {
  sessionInfoUpdate: number
  subSessionId: number
  trackId: number
  sessionNum: number
  sessionType: string
  sessionLaps: string | number
  sessionTimeTotal: string | number
  drivers: OverlayDriver[]
  classes: ClassInfo[]
  results: Array<{
    carIdx: number
    position: number
    classPosition: number
    fastestTime: number
    lastTime: number
    lapsComplete: number
    incidents: number
  }>
  fastestLap: Array<{ carIdx: number; fastestTime: number }>
}

export type ServerMessage =
  | SessionInfoMessage
  | TelemetryMessage
  | LapChangeMessage
  | StatusMessage
  | FieldMessage
  | SessionStateMessage

const ir = createIRSDK()
let tickCount = 0
let lastLap = -1
let lastSessionNum = -1
// SubSessionID:SessionNum:TrackID of the last published session_info —
// changes when the user joins a different session even if SessionNum repeats.
let lastSessionInfoFingerprint = ''

// Pre-allocate telemetry frame object to avoid allocations in hot path
const telemetryKeys = [
  'SessionTime', 'Lap', 'LapDistPct', 'Speed', 'RPM', 'Gear',
  'Throttle', 'Brake', 'Clutch', 'SteeringWheelAngle',
  'Lat', 'Lon', 'Alt', 'Yaw', 'Pitch', 'Roll',
  'LapCurrentLapTime', 'LapLastLapTime', 'LapBestLapTime', 'LapDeltaToBestLap',
  'FuelLevel', 'FuelLevelPct', 'OilTemp', 'WaterTemp', 'IsOnTrack',
  'PlayerCarPosition', 'PlayerCarClassPosition', 'BrakeABSactive',
  'dcBrakeBias', 'dcTractionControl', 'dcABS',
  'LFtempCL', 'RFtempCL', 'LRtempCL', 'RRtempCL',
  'LFpressure', 'RFpressure', 'LRpressure', 'RRpressure',
  'LFwearM', 'RFwearM', 'LRwearM', 'RRwearM',
  'SessionNum', 'OnPitRoad', 'PlayerCarIdx', 'CarIdxLapDistPct',
  'SessionFlags', 'CarLeftRight'
] as const

// Multi-car channels for the 15Hz field snapshot. Array vars return
// number[]/boolean[] of length 64 straight from the SDK.
const fieldKeys = [
  'CarIdxPosition', 'CarIdxClassPosition', 'CarIdxLap', 'CarIdxLapCompleted',
  'CarIdxEstTime', 'CarIdxF2Time', 'CarIdxOnPitRoad', 'CarIdxTrackSurface',
  'CarIdxLastLapTime', 'CarIdxBestLapTime',
  'SessionState', 'SessionTimeRemain', 'SessionLapsRemainEx',
] as const

// Pre-allocated object for zero-allocation reads
const telemetryData: Record<string, number | boolean | null | number[] | boolean[]> = {}
for (const key of telemetryKeys) {
  telemetryData[key] = null
}

const fieldData: Record<string, number | boolean | null | number[] | boolean[]> = {}
for (const key of fieldKeys) {
  fieldData[key] = null
}

// Reused rounded copy of CarIdxLapDistPct (4dp keeps the 60Hz frame small).
const roundedLapDistPct: number[] = new Array(64).fill(-1)

function numArray(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : []
}

function boolArray(value: unknown): boolean[] {
  return Array.isArray(value) ? (value as boolean[]) : []
}

function getSessionInfo(): SessionInfoMessage['data'] | null {
  const weekendInfo = ir.getSessionInfo<WeekendInfo>('WeekendInfo')
  const driverInfo = ir.getSessionInfo<DriverInfo>('DriverInfo')

  if (!weekendInfo || !driverInfo) return null

  const playerDriver: Driver | undefined = driverInfo.Drivers?.[driverInfo.DriverCarIdx ?? 0]
  const sessionNum = ir.get('SessionNum') as number ?? 0

  return {
    trackId: weekendInfo.TrackID,
    // SplitTimeInfo gives the frontend sector boundaries so it can compute
    // live sector times; without it the sector table has nothing to show.
    sectors: getSectorBoundaries(),
    trackName: weekendInfo.TrackName,
    trackDisplayName: weekendInfo.TrackDisplayName,
    trackLength: weekendInfo.TrackLength,
    trackConfig: weekendInfo.TrackConfigName,
    carId: playerDriver?.CarID ?? 0,
    carName: playerDriver?.CarScreenName ?? 'Unknown Car',
    carNumber: playerDriver?.CarNumber ?? '0',
    driverName: playerDriver?.UserName ?? 'Unknown Driver',
    driverId: playerDriver?.UserID ?? 0,
    sessionType: weekendInfo.EventType ?? 'Unknown',
    sessionNum,
    tickRate: 60,
  }
}

interface SplitTimeInfo {
  Sectors?: Array<{ SectorNum?: number; SectorStartPct?: number }>
}

function getSectorBoundaries(): Array<{ sectorNum: number; startPct: number }> {
  const splitTimeInfo = ir.getSessionInfo<SplitTimeInfo>('SplitTimeInfo')
  const sectors = splitTimeInfo?.Sectors
  if (!Array.isArray(sectors)) return []

  return sectors
    .map((s) => ({ sectorNum: s.SectorNum ?? -1, startPct: s.SectorStartPct ?? -1 }))
    .filter((s) => s.sectorNum >= 0 && s.startPct >= 0 && s.startPct < 1)
    .sort((a, b) => a.startPct - b.startPct)
}

function readNullableNum(key: string): number | null {
  const value = telemetryData[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Caller must hold the frozen var buffer (freeze/read frame + field/unfreeze
// happens once per tick in the publish loop).
function getTelemetryFrame(): TelemetryFrame {
  // Use batch read for better performance (single buffer traversal)
  ir.getMultipleInto(telemetryKeys as unknown as string[], telemetryData)

  const frame: TelemetryFrame = {
    tick: tickCount++,
    sessionTime: (telemetryData.SessionTime as number) ?? 0,
    lap: (telemetryData.Lap as number) ?? 0,
    lapDistPct: (telemetryData.LapDistPct as number) ?? 0,
    speed: (telemetryData.Speed as number) ?? 0,
    rpm: (telemetryData.RPM as number) ?? 0,
    gear: (telemetryData.Gear as number) ?? 0,
    throttle: (telemetryData.Throttle as number) ?? 0,
    brake: (telemetryData.Brake as number) ?? 0,
    clutch: (telemetryData.Clutch as number) ?? 0,
    steer: (telemetryData.SteeringWheelAngle as number) ?? 0,
    lat: (telemetryData.Lat as number) ?? 0,
    lon: (telemetryData.Lon as number) ?? 0,
    alt: (telemetryData.Alt as number) ?? 0,
    yaw: (telemetryData.Yaw as number) ?? 0,
    pitch: (telemetryData.Pitch as number) ?? 0,
    roll: (telemetryData.Roll as number) ?? 0,
    lapCurrentLapTime: (telemetryData.LapCurrentLapTime as number) ?? 0,
    lapLastLapTime: (telemetryData.LapLastLapTime as number) ?? 0,
    lapBestLapTime: (telemetryData.LapBestLapTime as number) ?? 0,
    lapDeltaToBestLap: (telemetryData.LapDeltaToBestLap as number) ?? 0,
    fuelLevel: (telemetryData.FuelLevel as number) ?? 0,
    fuelLevelPct: (telemetryData.FuelLevelPct as number) ?? 0,
    oilTemp: (telemetryData.OilTemp as number) ?? 0,
    waterTemp: (telemetryData.WaterTemp as number) ?? 0,
    isOnTrack: (telemetryData.IsOnTrack as boolean) ?? false,
    playerPosition: (telemetryData.PlayerCarPosition as number) ?? 0,
    playerClassPosition: (telemetryData.PlayerCarClassPosition as number) ?? 0,
    brakeABSactive: (telemetryData.BrakeABSactive as boolean) ?? false,
    dcBrakeBias: (telemetryData.dcBrakeBias as number) ?? 0,
    dcTractionControl: (telemetryData.dcTractionControl as number) ?? 0,
    dcABS: (telemetryData.dcABS as number) ?? 0,
    tireTempLF: (telemetryData.LFtempCL as number) ?? 0,
    tireTempRF: (telemetryData.RFtempCL as number) ?? 0,
    tireTempLR: (telemetryData.LRtempCL as number) ?? 0,
    tireTempRR: (telemetryData.RRtempCL as number) ?? 0,
    tirePressureLF: readNullableNum('LFpressure'),
    tirePressureRF: readNullableNum('RFpressure'),
    tirePressureLR: readNullableNum('LRpressure'),
    tirePressureRR: readNullableNum('RRpressure'),
    tireWearLF: readNullableNum('LFwearM'),
    tireWearRF: readNullableNum('RFwearM'),
    tireWearLR: readNullableNum('LRwearM'),
    tireWearRR: readNullableNum('RRwearM'),
    sessionNum: (telemetryData.SessionNum as number) ?? 0,
    onPitRoad: (telemetryData.OnPitRoad as boolean) ?? false,
    playerCarIdx: (telemetryData.PlayerCarIdx as number) ?? -1,
    carIdxLapDistPct: roundCarIdxLapDistPct(numArray(telemetryData.CarIdxLapDistPct)),
    // SessionFlags is a 32-bit bitfield read as a signed int — keep the bits.
    sessionFlags: ((telemetryData.SessionFlags as number) ?? 0) >>> 0,
    carLeftRight: (telemetryData.CarLeftRight as number) ?? 0,
  }

  return frame
}

function roundCarIdxLapDistPct(raw: number[]): number[] {
  for (let i = 0; i < roundedLapDistPct.length; i++) {
    const v = raw[i]
    roundedLapDistPct[i] = v == null || v < 0 ? -1 : Math.round(v * 10000) / 10000
  }
  return roundedLapDistPct
}

let cachedPaceCarIdx = -1

function getFieldData(frame: TelemetryFrame): FieldData {
  ir.getMultipleInto(fieldKeys as unknown as string[], fieldData)

  const round3 = (v: number) => Math.round(v * 1000) / 1000

  return {
    tick: frame.tick,
    sessionTime: frame.sessionTime,
    sessionNum: frame.sessionNum,
    sessionState: (fieldData.SessionState as number) ?? 0,
    sessionTimeRemain: (fieldData.SessionTimeRemain as number) ?? -1,
    sessionLapsRemain: (fieldData.SessionLapsRemainEx as number) ?? -1,
    playerCarIdx: frame.playerCarIdx,
    paceCarIdx: cachedPaceCarIdx,
    position: numArray(fieldData.CarIdxPosition),
    classPosition: numArray(fieldData.CarIdxClassPosition),
    lap: numArray(fieldData.CarIdxLap),
    lapCompleted: numArray(fieldData.CarIdxLapCompleted),
    lapDistPct: frame.carIdxLapDistPct,
    estTime: numArray(fieldData.CarIdxEstTime).map(round3),
    f2Time: numArray(fieldData.CarIdxF2Time).map(round3),
    onPitRoad: boolArray(fieldData.CarIdxOnPitRoad),
    trackSurface: numArray(fieldData.CarIdxTrackSurface),
    lastLapTime: numArray(fieldData.CarIdxLastLapTime).map(round3),
    bestLapTime: numArray(fieldData.CarIdxBestLapTime).map(round3),
  }
}

/** Standard iRacing strength-of-field: ln-based Elo mean over the class. */
function computeSof(ratings: number[]): number {
  if (ratings.length === 0) return 0
  const LN2 = Math.log(2)
  const sum = ratings.reduce((acc, r) => acc + Math.pow(2, -r / 1600), 0)
  if (sum <= 0) return 0
  return Math.round((1600 / LN2) * Math.log(ratings.length / sum))
}

function buildSessionState(sessionInfoUpdate: number): SessionStateData | null {
  const weekendInfo = ir.getSessionInfo<WeekendInfo>('WeekendInfo')
  const driverInfo = ir.getSessionInfo<DriverInfo>('DriverInfo')
  if (!weekendInfo || !driverInfo) return null

  const sessionNum = (ir.get('SessionNum') as number) ?? 0
  cachedPaceCarIdx = driverInfo.PaceCarIdx ?? -1

  const drivers: OverlayDriver[] = []
  for (const d of driverInfo.Drivers ?? []) {
    if (!d || d.CarIdx == null || d.CarIdx < 0) continue
    if (d.IsSpectator || d.CarIsPaceCar) continue
    drivers.push({
      carIdx: d.CarIdx,
      userName: d.UserName ?? 'Unknown',
      teamName: d.TeamName || undefined,
      carNumber: d.CarNumber ?? '',
      carClassId: d.CarClassID ?? 0,
      carClassShortName: d.CarClassShortName ?? '',
      carClassColor: d.CarClassColor ?? 0,
      carClassRelSpeed: d.CarClassRelSpeed ?? 0,
      carClassEstLapTime: d.CarClassEstLapTime ?? 0,
      iRating: d.IRating ?? 0,
      licString: d.LicString ?? '',
      licColor: d.LicColor ?? 0,
      incidentCount: d.CurDriverIncidentCount ?? 0,
    })
  }

  const byClass = new Map<number, OverlayDriver[]>()
  for (const d of drivers) {
    const list = byClass.get(d.carClassId)
    if (list) list.push(d)
    else byClass.set(d.carClassId, [d])
  }
  const classes: ClassInfo[] = [...byClass.entries()].map(([classId, list]) => ({
    classId,
    shortName: list[0]?.carClassShortName ?? '',
    color: list[0]?.carClassColor ?? 0,
    sof: computeSof(list.map((d) => d.iRating).filter((r) => r > 0)),
    carCount: list.length,
  }))

  const sessionsInfo = ir.getSessionInfo<SessionInfoData>('SessionInfo')
  const session =
    sessionsInfo?.Sessions?.find((s) => s.SessionNum === sessionNum) ??
    sessionsInfo?.Sessions?.[sessionsInfo.Sessions.length - 1]

  return {
    sessionInfoUpdate,
    subSessionId: weekendInfo.SubSessionID ?? 0,
    trackId: weekendInfo.TrackID,
    sessionNum,
    sessionType: session?.SessionType ?? weekendInfo.EventType ?? 'Unknown',
    sessionLaps: session?.SessionLaps ?? 'unlimited',
    sessionTimeTotal: session?.SessionTime ?? 'unlimited',
    drivers,
    classes,
    results: (session?.ResultsPositions ?? []).map((r) => ({
      carIdx: r.CarIdx ?? -1,
      position: r.Position ?? 0,
      classPosition: r.ClassPosition ?? 0,
      fastestTime: r.FastestTime ?? -1,
      lastTime: r.LastTime ?? -1,
      lapsComplete: r.LapsComplete ?? 0,
      incidents: r.Incidents ?? 0,
    })),
    fastestLap: (session?.ResultsFastestLap ?? []).map((f) => ({
      carIdx: f.CarIdx ?? -1,
      fastestTime: f.FastestTime ?? -1,
    })),
  }
}

// iRacing does not finalize LapLastLapTime on the exact tick the Lap counter
// increments — it settles a few ticks later. Hold the lap_change message for
// up to a second so the lapTime we send is the completed lap's real time.
const LAP_CHANGE_SETTLE_TICKS = 60

interface PendingLapChange {
  fromLap: number
  toLap: number
  sessionNum: number
  ticksWaited: number
  lastLapTimeAtChange: number
}

let pendingLapChange: PendingLapChange | null = null

function emitLapChange(pending: PendingLapChange, lapTime: number, server: ReturnType<typeof Bun.serve>): void {
  const lapChangeMsg: LapChangeMessage = {
    type: 'lap_change',
    data: {
      fromLap: pending.fromLap,
      toLap: pending.toLap,
      lapTime,
      sessionNum: pending.sessionNum,
    },
  }

  server.publish('telemetry', JSON.stringify(lapChangeMsg))
  console.log(`Lap ${pending.fromLap} completed: ${formatLapTime(lapTime)}`)
}

function checkLapChange(frame: TelemetryFrame, server: ReturnType<typeof Bun.serve>): void {
  const currentLap = frame.lap
  const currentSessionNum = (ir.get('SessionNum') as number) ?? 0

  if (currentSessionNum !== lastSessionNum) {
    lastSessionNum = currentSessionNum
    lastLap = currentLap
    lastSessionInfoFingerprint = ''
    pendingLapChange = null
    return
  }

  if (pendingLapChange) {
    pendingLapChange.ticksWaited++
    const settled = frame.lapLastLapTime > 0 && frame.lapLastLapTime !== pendingLapChange.lastLapTimeAtChange
    if (settled || pendingLapChange.ticksWaited >= LAP_CHANGE_SETTLE_TICKS) {
      emitLapChange(pendingLapChange, frame.lapLastLapTime, server)
      pendingLapChange = null
    }
  }

  if (currentLap !== lastLap && lastLap !== -1) {
    // A second lap boundary before the previous one settled: flush it as-is.
    if (pendingLapChange) {
      emitLapChange(pendingLapChange, frame.lapLastLapTime, server)
    }
    pendingLapChange = {
      fromLap: lastLap,
      toLap: currentLap,
      sessionNum: currentSessionNum,
      ticksWaited: 0,
      lastLapTimeAtChange: frame.lapLastLapTime,
    }
  }

  lastLap = currentLap
}

function formatLapTime(seconds: number): string {
  if (!seconds || seconds < 0 || seconds > 3600) return '--:--.---'
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(3).padStart(6, '0')
  return `${mins}:${secs}`
}

let cachedSessionStateJson: string | null = null

async function main() {
  // Serve immediately so overlays can health-check/connect before iRacing is
  // up; iRacing attach happens in a retry loop below. If the port is taken,
  // another sidecar instance already owns it — exit cleanly.
  const server = (() => {
    try {
      return Bun.serve({
    port: TELEMETRY_PORT,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === '/ws' || req.headers.get('upgrade') === 'websocket') {
        const success = server.upgrade(req)
        if (success) {
          return undefined
        }
        return new Response('WebSocket upgrade failed', { status: 400, headers: CORS_HEADERS })
      }

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      if (url.pathname === '/status') {
        return Response.json(
          {
            connected: ir.isConnected,
            initialized: ir.isInitialized,
            protocol: PROTOCOL_VERSION,
            sessionInfo: getSessionInfo(),
          },
          { headers: CORS_HEADERS },
        )
      }

      if (url.pathname === '/health') {
        return Response.json({ ok: true, protocol: PROTOCOL_VERSION }, { headers: CORS_HEADERS })
      }

      // Lets a newer client replace a stale instance holding the port.
      if (url.pathname === '/shutdown' && req.method === 'POST') {
        console.log('Shutdown requested by client')
        setTimeout(() => {
          ir.shutdown()
          process.exit(0)
        }, 50)
        return new Response('shutting down', { headers: CORS_HEADERS })
      }

      return new Response('Not found', { status: 404, headers: CORS_HEADERS })
    },
    websocket: {
      open(ws) {
        console.log('Client connected')
        ws.subscribe('telemetry')

        const statusMsg: StatusMessage = {
          type: 'status',
          data: {
            connected: ir.isConnected,
            initialized: ir.isInitialized,
          },
        }
        ws.send(JSON.stringify(statusMsg))

        const sessionInfo = getSessionInfo()
        if (sessionInfo) {
          const sessionMsg: SessionInfoMessage = {
            type: 'session_info',
            data: sessionInfo,
          }
          ws.send(JSON.stringify(sessionMsg))
        }

        if (cachedSessionStateJson) {
          ws.send(cachedSessionStateJson)
        }
      },
      close(ws) {
        console.log('Client disconnected')
      },
      message(ws, msg) {
        // Handle client commands if needed
      },
    },
    })
    } catch (err) {
      console.error('Could not bind port — another sidecar instance is likely running:', err)
      process.exit(0)
    }
  })()

  console.log(`\nTelemetry server running at ws://127.0.0.1:${server.port}/ws`)
  console.log(`Status endpoint: http://127.0.0.1:${server.port}/status`)
  console.log('Waiting for iRacing...\n')

  // Attach to iRacing in the background; retry until the sim is up. If the
  // sim exits, the old shared-memory mapping points at a dead section — after
  // a sustained disconnect, unmap and re-attach so a relaunched sim (a new
  // session) is picked up instead of reading orphaned memory forever.
  const REATTACH_AFTER_MS = 10_000
  let startupInFlight = false
  let wasConnected = false
  let disconnectedSince: number | null = null
  const ensureIRacing = async () => {
    if (startupInFlight) return

    if (ir.isInitialized) {
      if (ir.isConnected) {
        disconnectedSince = null
        return
      }
      disconnectedSince ??= Date.now()
      if (Date.now() - disconnectedSince < REATTACH_AFTER_MS) return
      console.log('iRacing gone — detaching and waiting for a new session')
      ir.shutdown()
      lastSessionInfoFingerprint = ''
      cachedSessionStateJson = null
      disconnectedSince = null
    }

    startupInFlight = true
    try {
      const ok = await ir.startup()
      if (ok) {
        console.log('Connected to iRacing!')
        const sessionInfo = getSessionInfo()
        if (sessionInfo) {
          console.log(`Track: ${sessionInfo.trackDisplayName}`)
          console.log(`Driver: ${sessionInfo.driverName}`)
          console.log(`Car: ${sessionInfo.carName} #${sessionInfo.carNumber}`)
        }
      }
    } catch (err) {
      console.error('iRacing startup attempt failed:', err)
    } finally {
      startupInFlight = false
    }
  }
  await ensureIRacing()
  setInterval(ensureIRacing, 2000)

  let lastSessionInfoTime = 0
  let fieldTickCounter = 0
  let lastSessionStateCheck = 0
  let lastSessionStatePublish = 0
  let lastPublishedSessionInfoUpdate = -1

  setInterval(() => {
    const connected = ir.isConnected && ir.isInitialized
    if (connected !== wasConnected) {
      wasConnected = connected
      const statusMsg: StatusMessage = {
        type: 'status',
        data: { connected, initialized: ir.isInitialized },
      }
      server.publish('telemetry', JSON.stringify(statusMsg))
    }
    if (!connected) {
      return
    }

    // One freeze covers both the player frame and the field snapshot so they
    // come from the same tick.
    ir.freezeVarBufferLatest()
    const frame = getTelemetryFrame()
    fieldTickCounter++
    const field = fieldTickCounter % FIELD_PUBLISH_EVERY === 0 ? getFieldData(frame) : null
    ir.unfreezeVarBufferLatest()

    checkLapChange(frame, server)

    const telemetryMsg: TelemetryMessage = {
      type: 'telemetry',
      data: frame,
    }
    server.publish('telemetry', JSON.stringify(telemetryMsg))

    if (field) {
      const fieldMsg: FieldMessage = { type: 'field', data: field }
      server.publish('telemetry', JSON.stringify(fieldMsg))
    }

    const now = Date.now()
    if (now - lastSessionInfoTime > 1000 / SESSION_INFO_RATE_HZ) {
      lastSessionInfoTime = now
      // Re-publish when the session identity changes — joining a different
      // subsession can keep the same SessionNum, so the number alone is not
      // enough to notice a new track/car/sector layout.
      const weekendInfo = ir.getSessionInfo<WeekendInfo>('WeekendInfo')
      if (weekendInfo) {
        const sessionNum = (ir.get('SessionNum') as number) ?? 0
        const fingerprint = `${weekendInfo.SubSessionID ?? 0}:${sessionNum}:${weekendInfo.TrackID ?? 0}`
        if (fingerprint !== lastSessionInfoFingerprint) {
          const sessionInfo = getSessionInfo()
          if (sessionInfo) {
            const sessionMsg: SessionInfoMessage = {
              type: 'session_info',
              data: sessionInfo,
            }
            server.publish('telemetry', JSON.stringify(sessionMsg))
            lastSessionInfoFingerprint = fingerprint
          }
        }
      }
    }

    // Roster/results snapshot when iRacing bumps its session-info counter
    // (driver join/leave, results update) — checked at 2Hz, published ≥1s apart.
    if (now - lastSessionStateCheck > 500) {
      lastSessionStateCheck = now
      const counter = ir.sessionInfoUpdate
      if (counter !== lastPublishedSessionInfoUpdate && now - lastSessionStatePublish >= 1000) {
        const state = buildSessionState(counter)
        if (state) {
          const stateMsg: SessionStateMessage = { type: 'session_state', data: state }
          cachedSessionStateJson = JSON.stringify(stateMsg)
          server.publish('telemetry', cachedSessionStateJson)
          lastPublishedSessionInfoUpdate = counter
          lastSessionStatePublish = now
        }
      }
    }
  }, 1000 / TELEMETRY_RATE_HZ)

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    ir.shutdown()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\nShutting down...')
    ir.shutdown()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
