#!/usr/bin/env bun

import { createIRSDK } from './live'
import type { WeekendInfo, DriverInfo, Driver } from './types'

const TELEMETRY_PORT = 32100
const TELEMETRY_RATE_HZ = 60
const SESSION_INFO_RATE_HZ = 1

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

export type ServerMessage = SessionInfoMessage | TelemetryMessage | LapChangeMessage | StatusMessage

const telemetryVars = [
  'SessionTime',
  'SessionNum',
  'Lap',
  'LapDistPct',
  'Speed',
  'RPM',
  'Gear',
  'Throttle',
  'Brake',
  'Clutch',
  'SteeringWheelAngle',
  'Lat',
  'Lon',
  'Alt',
  'Yaw',
  'Pitch',
  'Roll',
  'LapCurrentLapTime',
  'LapLastLapTime',
  'LapBestLapTime',
  'LapDeltaToBestLap',
  'FuelLevel',
  'FuelLevelPct',
  'OilTemp',
  'WaterTemp',
  'IsOnTrack',
  'PlayerCarPosition',
  'PlayerCarClassPosition',
  'BrakeABSactive',
  'dcBrakeBias',
  'dcTractionControl',
  'dcABS',
  'LFtempCL',
  'RFtempCL',
  'LRtempCL',
  'RRtempCL',
] as const

const ir = createIRSDK()
let tickCount = 0
let lastLap = -1
let lastSessionNum = -1
let sessionInfoSent = false

async function connectToIRacing(): Promise<boolean> {
  console.log('Connecting to iRacing...')
  const connected = await ir.startup()

  if (!connected) {
    console.error('Failed to connect to iRacing. Make sure iRacing is running.')
    return false
  }

  console.log('Connected to iRacing!')
  return true
}

function getSessionInfo(): SessionInfoMessage['data'] | null {
  const weekendInfo = ir.getSessionInfo<WeekendInfo>('WeekendInfo')
  const driverInfo = ir.getSessionInfo<DriverInfo>('DriverInfo')

  if (!weekendInfo || !driverInfo) return null

  const playerDriver: Driver | undefined = driverInfo.Drivers?.[driverInfo.DriverCarIdx ?? 0]
  const sessionNum = ir.get('SessionNum') as number ?? 0

  return {
    trackId: weekendInfo.TrackID,
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

function getTelemetryFrame(): TelemetryFrame {
  ir.freezeVarBufferLatest()

  const frame: TelemetryFrame = {
    tick: tickCount++,
    sessionTime: (ir.get('SessionTime') as number) ?? 0,
    lap: (ir.get('Lap') as number) ?? 0,
    lapDistPct: (ir.get('LapDistPct') as number) ?? 0,
    speed: (ir.get('Speed') as number) ?? 0,
    rpm: (ir.get('RPM') as number) ?? 0,
    gear: (ir.get('Gear') as number) ?? 0,
    throttle: (ir.get('Throttle') as number) ?? 0,
    brake: (ir.get('Brake') as number) ?? 0,
    clutch: (ir.get('Clutch') as number) ?? 0,
    steer: (ir.get('SteeringWheelAngle') as number) ?? 0,
    lat: (ir.get('Lat') as number) ?? 0,
    lon: (ir.get('Lon') as number) ?? 0,
    alt: (ir.get('Alt') as number) ?? 0,
    yaw: (ir.get('Yaw') as number) ?? 0,
    pitch: (ir.get('Pitch') as number) ?? 0,
    roll: (ir.get('Roll') as number) ?? 0,
    lapCurrentLapTime: (ir.get('LapCurrentLapTime') as number) ?? 0,
    lapLastLapTime: (ir.get('LapLastLapTime') as number) ?? 0,
    lapBestLapTime: (ir.get('LapBestLapTime') as number) ?? 0,
    lapDeltaToBestLap: (ir.get('LapDeltaToBestLap') as number) ?? 0,
    fuelLevel: (ir.get('FuelLevel') as number) ?? 0,
    fuelLevelPct: (ir.get('FuelLevelPct') as number) ?? 0,
    oilTemp: (ir.get('OilTemp') as number) ?? 0,
    waterTemp: (ir.get('WaterTemp') as number) ?? 0,
    isOnTrack: (ir.get('IsOnTrack') as boolean) ?? false,
    playerPosition: (ir.get('PlayerCarPosition') as number) ?? 0,
    playerClassPosition: (ir.get('PlayerCarClassPosition') as number) ?? 0,
    brakeABSactive: (ir.get('BrakeABSactive') as boolean) ?? false,
    dcBrakeBias: (ir.get('dcBrakeBias') as number) ?? 0,
    dcTractionControl: (ir.get('dcTractionControl') as number) ?? 0,
    dcABS: (ir.get('dcABS') as number) ?? 0,
    tireTempLF: (ir.get('LFtempCL') as number) ?? 0,
    tireTempRF: (ir.get('RFtempCL') as number) ?? 0,
    tireTempLR: (ir.get('LRtempCL') as number) ?? 0,
    tireTempRR: (ir.get('RRtempCL') as number) ?? 0,
  }

  ir.unfreezeVarBufferLatest()

  return frame
}

function checkLapChange(frame: TelemetryFrame, server: ReturnType<typeof Bun.serve>): void {
  const currentLap = frame.lap
  const currentSessionNum = (ir.get('SessionNum') as number) ?? 0

  if (currentSessionNum !== lastSessionNum) {
    lastSessionNum = currentSessionNum
    lastLap = currentLap
    sessionInfoSent = false
    return
  }

  if (currentLap !== lastLap && lastLap !== -1) {
    const lapChangeMsg: LapChangeMessage = {
      type: 'lap_change',
      data: {
        fromLap: lastLap,
        toLap: currentLap,
        lapTime: frame.lapLastLapTime,
        sessionNum: currentSessionNum,
      },
    }

    server.publish('telemetry', JSON.stringify(lapChangeMsg))
    console.log(`Lap ${lastLap} completed: ${formatLapTime(frame.lapLastLapTime)}`)
  }

  lastLap = currentLap
}

function formatLapTime(seconds: number): string {
  if (!seconds || seconds < 0 || seconds > 3600) return '--:--.---'
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(3).padStart(6, '0')
  return `${mins}:${secs}`
}

async function main() {
  const connected = await connectToIRacing()

  if (!connected) {
    process.exit(1)
  }

  const sessionInfo = getSessionInfo()
  if (sessionInfo) {
    console.log(`Track: ${sessionInfo.trackDisplayName}`)
    console.log(`Driver: ${sessionInfo.driverName}`)
    console.log(`Car: ${sessionInfo.carName} #${sessionInfo.carNumber}`)
  }

  const server = Bun.serve({
    port: TELEMETRY_PORT,
    fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === '/ws' || req.headers.get('upgrade') === 'websocket') {
        const success = server.upgrade(req)
        if (success) {
          return undefined
        }
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname === '/status') {
        return Response.json({
          connected: ir.isConnected,
          initialized: ir.isInitialized,
          sessionInfo: getSessionInfo(),
        })
      }

      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 })
      }

      return new Response('Not found', { status: 404 })
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
      },
      close(ws) {
        console.log('Client disconnected')
      },
      message(ws, msg) {
        // Handle client commands if needed
      },
    },
  })

  console.log(`\nTelemetry server running at ws://127.0.0.1:${server.port}/ws`)
  console.log(`Status endpoint: http://127.0.0.1:${server.port}/status`)
  console.log('Waiting for connections...\n')

  let lastSessionInfoTime = 0

  setInterval(() => {
    if (!ir.isConnected) {
      return
    }

    const frame = getTelemetryFrame()

    checkLapChange(frame, server)

    const telemetryMsg: TelemetryMessage = {
      type: 'telemetry',
      data: frame,
    }
    server.publish('telemetry', JSON.stringify(telemetryMsg))

    const now = Date.now()
    if (now - lastSessionInfoTime > 1000 / SESSION_INFO_RATE_HZ) {
      lastSessionInfoTime = now
      const sessionInfo = getSessionInfo()
      if (sessionInfo && !sessionInfoSent) {
        const sessionMsg: SessionInfoMessage = {
          type: 'session_info',
          data: sessionInfo,
        }
        server.publish('telemetry', JSON.stringify(sessionMsg))
        sessionInfoSent = true
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
