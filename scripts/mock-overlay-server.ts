#!/usr/bin/env bun
/**
 * Mock of the hotlap-telemetry sidecar protocol for developing/verifying the
 * overlay windows without iRacing. 20 cars in 2 classes orbit Road Atlanta
 * (trackId 127) at slightly different speeds.
 *
 * Scripted events:
 *  - t+60s..90s: car 7 pits (onPitRoad)
 *  - t+90s:      car 12 disconnects (trackSurface -1)
 *  - player fuel burns ~0.9L/lap from 40L
 *
 * Usage: bun run scripts/mock-overlay-server.ts   (PORT env to override 32100)
 * Point the UI at it: sessionStorage.setItem('hotlap.telemetryWsUrl', 'ws://127.0.0.1:<port>/ws')
 */

const PORT = Number(process.env.PORT ?? 32100)
const RATE_HZ = 60
const TRACK_LENGTH_KM = 4.088
const PLAYER_CAR_IDX = 5
const CAR_COUNT = 20

const CLASS_A = { id: 2708, shortName: 'GT3', color: 0xff4f9d, estLap: 95, relSpeed: 1.0 }
const CLASS_B = { id: 3189, shortName: 'GTE', color: 0x33ceff, estLap: 88, relSpeed: 1.08 }

const FIRST = ['Alex', 'Marco', 'Sindre', 'Neil', 'Istvan', 'Renan', 'Fabian', 'Marius', 'Rick', 'Antti',
  'Samuel', 'Adaildo', 'Preston', 'Matthew', 'Nick', 'Daniel', 'Sergio', 'Lucas', 'Emil', 'Jorge']
const LAST = ['Naylor', 'Acunto', 'Setsaas', 'Cooper', 'Fodor', 'Azeredo', 'Seischegg', 'Rieck', 'Zwieten',
  'Terho', 'Libeert', 'Vieira', 'Perlmutter', 'Hearn', 'Falb', 'Illes', 'Masellis', 'Ordonez', 'Berg', 'Prado']

interface MockCar {
  carIdx: number
  name: string
  cls: typeof CLASS_A
  lapTimeSec: number
  startOffsetSec: number
  iRating: number
  licString: string
  licColor: number
  carNumber: string
  bestLap: number
  lastLap: number
  connected: boolean
}

const cars: MockCar[] = []
for (let i = 0; i < CAR_COUNT; i++) {
  const cls = i < 10 ? CLASS_B : CLASS_A
  const skill = (i % 10) / 10
  cars.push({
    carIdx: i + 1,
    name: `${FIRST[i]} ${LAST[i]}`,
    cls,
    lapTimeSec: cls.estLap + skill * 4 + (i % 3) * 0.7,
    startOffsetSec: -i * 2.5,
    iRating: Math.round(8000 - skill * 6200 - (i % 4) * 350),
    licString: ['A 4.99', 'A 3.71', 'B 3.30', 'B 2.55', 'C 2.11'][i % 5],
    licColor: [0x0153db, 0x0153db, 0x00c702, 0x00c702, 0xfeec04][i % 5],
    carNumber: String(i + 1),
    bestLap: -1,
    lastLap: -1,
    connected: true,
  })
}

// Car 6 shadows the player a few meters back so the radar has a target.
cars[5]!.lapTimeSec = cars[PLAYER_CAR_IDX - 1]!.lapTimeSec
cars[5]!.startOffsetSec = cars[PLAYER_CAR_IDX - 1]!.startOffsetSec - 0.09

const sectors = [
  { sectorNum: 0, startPct: 0 },
  { sectorNum: 1, startPct: 0.35 },
  { sectorNum: 2, startPct: 0.7 },
]

// irsdk_Flags bits used by the scripted flag sequence
const FLAG_GREEN = 0x4
const FLAG_YELLOW = 0x8
const FLAG_BLUE = 0x20

function computeSof(ratings: number[]): number {
  if (!ratings.length) return 0
  const sum = ratings.reduce((acc, r) => acc + Math.pow(2, -r / 1600), 0)
  return Math.round((1600 / Math.LN2) * Math.log(ratings.length / sum))
}

function buildSessionState(sessionInfoUpdate: number) {
  const byClass = new Map<number, MockCar[]>()
  for (const car of cars) {
    const list = byClass.get(car.cls.id) ?? []
    list.push(car)
    byClass.set(car.cls.id, list)
  }
  return {
    sessionInfoUpdate,
    subSessionId: 99999001,
    trackId: 127,
    sessionNum: 0,
    sessionType: 'Practice',
    sessionLaps: 'unlimited',
    sessionTimeTotal: '3600.0000 sec',
    drivers: cars.map((car) => ({
      carIdx: car.carIdx,
      userName: car.name,
      carNumber: car.carNumber,
      carClassId: car.cls.id,
      carClassShortName: car.cls.shortName,
      carClassColor: car.cls.color,
      carClassRelSpeed: car.cls.relSpeed,
      carClassEstLapTime: car.cls.estLap,
      iRating: car.iRating,
      licString: car.licString,
      licColor: car.licColor,
      incidentCount: 0,
    })),
    classes: [...byClass.entries()].map(([classId, list]) => ({
      classId,
      shortName: list[0]!.cls.shortName,
      color: list[0]!.cls.color,
      sof: computeSof(list.map((c) => c.iRating)),
      carCount: list.length,
    })),
    results: cars.map((car) => ({
      carIdx: car.carIdx,
      position: 0,
      classPosition: 0,
      fastestTime: car.bestLap,
      lastTime: car.lastLap,
      lapsComplete: 0,
      incidents: 0,
    })),
    fastestLap: [],
  }
}

const sessionInfo = {
  trackId: 127,
  trackName: 'roadatlanta full',
  trackDisplayName: 'Road Atlanta',
  trackLength: `${(TRACK_LENGTH_KM / 1.60934).toFixed(2)} mi`,
  trackConfig: '',
  carId: 1,
  carName: 'Mock GT3',
  carNumber: String(PLAYER_CAR_IDX),
  driverName: cars[PLAYER_CAR_IDX - 1]!.name,
  driverId: 1,
  sessionType: 'Practice',
  sessionNum: 0,
  tickRate: RATE_HZ,
  sectors,
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/ws' || req.headers.get('upgrade') === 'websocket') {
      if (server.upgrade(req)) return undefined
      return new Response('upgrade failed', { status: 400 })
    }
    const cors = { 'Access-Control-Allow-Origin': '*' }
    if (url.pathname === '/status') {
      return Response.json({ connected: true, initialized: true, protocol: 3, sessionInfo }, { headers: cors })
    }
    if (url.pathname === '/health') return Response.json({ ok: true, protocol: 3 }, { headers: cors })
    return new Response('not found', { status: 404, headers: cors })
  },
  websocket: {
    open(ws) {
      console.log('client connected')
      ws.subscribe('telemetry')
      ws.send(JSON.stringify({ type: 'status', data: { connected: true, initialized: true } }))
      ws.send(JSON.stringify({ type: 'session_info', data: sessionInfo }))
      ws.send(JSON.stringify({ type: 'session_state', data: buildSessionState(1) }))
    },
    close() { console.log('client disconnected') },
    message() {},
  },
})

console.log(`mock overlay server on ws://127.0.0.1:${PORT}/ws (player carIdx ${PLAYER_CAR_IDX})`)

let tick = 0
let playerLastLap = 1
let pendingLapChange: { fromLap: number; toLap: number; ticks: number; lapTime: number } | null = null
let sessionStateVersion = 1

setInterval(() => {
  tick++
  const t = tick / RATE_HZ

  // Scripted events
  const car7 = cars[6]!
  const car7Pitting = t > 60 && t < 90
  const car12 = cars[11]!
  if (t > 90 && car12.connected) {
    car12.connected = false
    sessionStateVersion++
    server.publish('telemetry', JSON.stringify({ type: 'session_state', data: buildSessionState(sessionStateVersion) }))
    console.log('car 12 disconnected')
  }

  // Per-car simulation
  const n = 64
  const lapDistPct = new Array(n).fill(-1)
  const lap = new Array(n).fill(-1)
  const lapCompleted = new Array(n).fill(-1)
  const estTime = new Array(n).fill(0)
  const f2Time = new Array(n).fill(0)
  const onPitRoad = new Array(n).fill(false)
  const trackSurface = new Array(n).fill(-1)
  const lastLapTime = new Array(n).fill(-1)
  const bestLapTime = new Array(n).fill(-1)
  const position = new Array(n).fill(0)
  const classPosition = new Array(n).fill(0)

  const totals: Array<{ car: MockCar; total: number }> = []

  for (const car of cars) {
    if (!car.connected) continue
    const speedScale = car.carIdx === 7 && car7Pitting ? 0.4 : 1
    const elapsed = Math.max(0, t + car.startOffsetSec) * speedScale
    const laps = elapsed / car.lapTimeSec
    const lapNum = Math.floor(laps) + 1
    const pct = laps % 1

    const idx = car.carIdx
    lapDistPct[idx] = Math.round(pct * 10000) / 10000
    lap[idx] = lapNum
    lapCompleted[idx] = lapNum - 1
    estTime[idx] = Math.round(pct * car.lapTimeSec * 1000) / 1000
    onPitRoad[idx] = car.carIdx === 7 && car7Pitting
    trackSurface[idx] = onPitRoad[idx] ? 2 : 3

    if (lapNum > 1) {
      const noise = Math.sin(car.carIdx * 7 + lapNum) * 0.4
      car.lastLap = car.lapTimeSec + noise
      car.bestLap = car.bestLap < 0 ? car.lastLap : Math.min(car.bestLap, car.lastLap)
      lastLapTime[idx] = Math.round(car.lastLap * 1000) / 1000
      bestLapTime[idx] = Math.round(car.bestLap * 1000) / 1000
    }

    totals.push({ car, total: lapNum + pct })
  }

  // Positions overall and per class
  totals.sort((a, b) => b.total - a.total)
  const classCounters = new Map<number, number>()
  totals.forEach((entry, i) => {
    position[entry.car.carIdx] = i + 1
    const cp = (classCounters.get(entry.car.cls.id) ?? 0) + 1
    classCounters.set(entry.car.cls.id, cp)
    classPosition[entry.car.carIdx] = cp
  })

  // Player frame
  const player = cars[PLAYER_CAR_IDX - 1]!
  const pPct = lapDistPct[PLAYER_CAR_IDX] >= 0 ? lapDistPct[PLAYER_CAR_IDX] : 0
  const pLap = lap[PLAYER_CAR_IDX] >= 0 ? lap[PLAYER_CAR_IDX] : 1
  const phase = pPct * Math.PI * 2
  const throttle = Math.max(0, Math.sin(phase * 3))
  const brake = Math.max(0, -Math.sin(phase * 3 + 0.4)) * 0.9
  const speedMs = 45 + 25 * Math.sin(phase * 3)

  if (pLap !== playerLastLap) {
    pendingLapChange = {
      fromLap: playerLastLap,
      toLap: pLap,
      ticks: RATE_HZ,
      lapTime: player.lastLap > 0 ? player.lastLap : player.lapTimeSec,
    }
    playerLastLap = pLap
  }
  if (pendingLapChange && --pendingLapChange.ticks <= 0) {
    server.publish('telemetry', JSON.stringify({
      type: 'lap_change',
      data: { fromLap: pendingLapChange.fromLap, toLap: pendingLapChange.toLap, lapTime: pendingLapChange.lapTime, sessionNum: 0 },
    }))
    pendingLapChange = null
  }

  const frame = {
    tick,
    sessionTime: t,
    lap: pLap,
    lapDistPct: pPct,
    speed: speedMs,
    rpm: 3500 + (speedMs / 70) * 4000,
    gear: Math.max(1, Math.min(6, Math.floor(speedMs / 12))),
    throttle,
    brake,
    clutch: 0,
    steer: Math.sin(phase * 5) * 0.8,
    lat: 0, lon: 0, alt: 0, yaw: 0, pitch: 0, roll: 0,
    lapCurrentLapTime: (pPct * player.lapTimeSec),
    lapLastLapTime: player.lastLap,
    lapBestLapTime: player.bestLap,
    lapDeltaToBestLap: Math.sin(phase) * 0.5,
    fuelLevel: Math.max(0, 40 - (pLap - 1) * 0.9 - pPct * 0.9),
    fuelLevelPct: Math.max(0, (40 - (pLap - 1) * 0.9) / 40),
    oilTemp: 105,
    waterTemp: 88,
    isOnTrack: true,
    playerPosition: position[PLAYER_CAR_IDX],
    playerClassPosition: classPosition[PLAYER_CAR_IDX],
    brakeABSactive: brake > 0.8,
    dcBrakeBias: 52, dcTractionControl: 3, dcABS: 2,
    tireTempLF: 82, tireTempRF: 86, tireTempLR: 80, tireTempRR: 84,
    tirePressureLF: 165, tirePressureRF: 166, tirePressureLR: 163, tirePressureRR: 164,
    tireWearLF: 0.98, tireWearRF: 0.97, tireWearLR: 0.99, tireWearRR: 0.98,
    sessionNum: 0,
    onPitRoad: false,
    playerCarIdx: PLAYER_CAR_IDX,
    carIdxLapDistPct: lapDistPct,
    // Scripted flags: blue 60-75s, yellow 120-140s, green otherwise.
    sessionFlags:
      t > 120 && t < 140 ? FLAG_YELLOW : t > 60 && t < 75 ? FLAG_GREEN | FLAG_BLUE : FLAG_GREEN,
    carLeftRight: (() => {
      let minAbs = Infinity
      for (let idx = 0; idx < 64; idx++) {
        if (idx === PLAYER_CAR_IDX || lapDistPct[idx] < 0) continue
        let d = (lapDistPct[idx] - pPct) % 1
        if (d >= 0.5) d -= 1
        if (d < -0.5) d += 1
        const meters = Math.abs(d) * TRACK_LENGTH_KM * 1000
        if (meters < minAbs) minAbs = meters
      }
      return minAbs < 6 ? 2 /* car left */ : minAbs < 30 ? 1 /* clear */ : 0
    })(),
  }
  server.publish('telemetry', JSON.stringify({ type: 'telemetry', data: frame }))

  if (tick % 4 === 0) {
    server.publish('telemetry', JSON.stringify({
      type: 'field',
      data: {
        tick,
        sessionTime: t,
        sessionNum: 0,
        sessionState: 4,
        sessionTimeRemain: 3600 - t,
        sessionLapsRemain: 32767,
        playerCarIdx: PLAYER_CAR_IDX,
        paceCarIdx: 0,
        position, classPosition, lap, lapCompleted, lapDistPct,
        estTime, f2Time, onPitRoad, trackSurface, lastLapTime, bestLapTime,
      },
    }))
  }
}, 1000 / RATE_HZ)
