# @hotlap.ai/telemetry

[![npm version](https://img.shields.io/npm/v/@hotlap.ai/telemetry.svg)](https://www.npmjs.com/package/@hotlap.ai/telemetry)
[![npm downloads](https://img.shields.io/npm/dm/@hotlap.ai/telemetry.svg)](https://www.npmjs.com/package/@hotlap.ai/telemetry)
[![CI](https://github.com/hotlap-ai/telemetry/actions/workflows/ci.yml/badge.svg)](https://github.com/hotlap-ai/telemetry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.0.0-black.svg)](https://bun.sh/)

High-performance sim-racing telemetry library for [Bun](https://bun.sh), built by the [HotLap.ai](https://hotlap.ai) team. Parse iRacing IBT files and Le Mans Ultimate recordings, and stream live data from iRacing via Windows shared memory.

> **Note:** This is an unofficial community library, not affiliated with or endorsed by iRacing.com or Motorsport Games.

## Features

- **IBT File Parsing** - Read and analyze iRacing telemetry binary files (.ibt)
- **Le Mans Ultimate** - Turn LMU `.duckdb` recordings into the same lap points as IBT files (runtime-neutral, bring your own DuckDB)
- **Live Telemetry** - Stream real-time data from iRacing via Windows shared memory (FFI)
- **WebSocket Server** - Built-in telemetry server for real-time data streaming
- **Full TypeScript Support** - Complete type definitions for all APIs
- **High Performance** - Optimized binary parsing with minimal allocations

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- Windows (for live telemetry features)
- iRacing (for live telemetry)

## Installation

```bash
bun add @hotlap.ai/telemetry
```

## Usage

### Parse IBT Files

```typescript
import { IBT } from '@hotlap.ai/telemetry';

const ibt = new IBT();
await ibt.open('./telemetry.ibt');

// Get session info
const weekendInfo = ibt.getSessionInfo('WeekendInfo');
console.log(`Track: ${weekendInfo.TrackDisplayName}`);

// Read telemetry data
const speed = ibt.get('Speed', 0); // Get speed at tick 0
const allSpeeds = ibt.getAll('Speed'); // Get all speed values

// Iterate through records
for (let i = 0; i < ibt.recordCount; i++) {
  const lap = ibt.get('Lap', i);
  const throttle = ibt.get('Throttle', i);
  const brake = ibt.get('Brake', i);
}
```

### Le Mans Ultimate Recordings

LMU (v1.2+) writes each session to `<LMU install>/UserData/Telemetry/*.duckdb` once
*Settings → Gameplay → Automatic Telemetry Recording* is on. `@hotlap.ai/telemetry/lmu`
is runtime-neutral: it carries no DuckDB and does no file I/O. You open the file with
whichever DuckDB your runtime has and hand over an `LmuTableSource`:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { LMU_CHANNELS_USED, LMU_EVENTS_USED, normalizeLmuRecording, readLmuTables } from '@hotlap.ai/telemetry/lmu';

const db = await DuckDBInstance.create('session.duckdb', { access_mode: 'READ_ONLY' });
const conn = await db.connect();
const recording = await readLmuTables(
  {
    queryRows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS(),
    readColumns: async (sql) => {
      const reader = await conn.runAndReadAll(sql);
      return { columnNames: reader.columnNames(), columns: reader.getColumnsJS() };
    },
  },
  { channels: LMU_CHANNELS_USED, events: LMU_EVENTS_USED }, // skip the ~85 unused tables
);
conn.closeSync();
db.closeSync();

const { session, laps, warnings } = normalizeLmuRecording(recording, { maxPoints: 1000 });
console.log(session.trackName, session.trackLengthKm, laps.map((l) => l.lapTimeSec));
```

Each lap has `byDist` / `byTime` `LapPoint` series (the same shape `extractLapPoints`
returns for IBT files), `sectorTimes`, LMU's official `lapTimeSec`, `completionPct` (a
fraction of the layout length) and `flags`, using the same `LapFlag` vocabulary as
`normalizeIbt`: `no-lap-last-time`, `pit-lane`, `low-completion`, `distance-mismatch`,
`unrealistic-speed` (thresholds in `LMU_THRESHOLDS`). `isClean` means no flags.

#### Bundles: LMU laps on hosts without DuckDB

Servers (Supabase Edge Functions) can't run DuckDB. The host that can packs the tables
into an **LMU bundle**, a store-only zip of one Snappy Parquet file per table plus a
`manifest.json`, which any JavaScript runtime reads back with no native code:

```typescript
import {
  LMU_BUNDLE_CHANNELS, LMU_CHANNELS_USED, LMU_EVENTS_USED,
  normalizeLmuRecording, packLmuBundle, readLmuBundle, readLmuTables,
} from '@hotlap.ai/telemetry/lmu';

// Where DuckDB runs: every event plus the channels HotLap.ai uses or plans to.
const recording = await readLmuTables(source, { channels: LMU_BUNDLE_CHANNELS });
const bundle = packLmuBundle(recording, { fileName, sha256, sizeBytes }); // Uint8Array, <name>.lmu.zip

// Anywhere (Deno, browser, Bun): identical laps to reading the .duckdb.
const { manifest, recording: fromBundle } = await readLmuBundle(bundle, { channels: LMU_CHANNELS_USED, events: LMU_EVENTS_USED });
const { laps } = normalizeLmuRecording(fromBundle);
```

Values are lossless: channel columns are FLOAT when every value fits float32 (LMU writes
FLOAT) and come back as `Float32Array`; `GPS Time` is DOUBLE. A one-hour session of the
normalizer's channels is about 14 MB. `manifest.source.sha256` is the original
recording's hash, so a bundle stays tied to the file it came from.

What the mapping relies on (cross-checked against independent open-source parsers):

- Index tables `metadata(key, value)`, `channelsList(channelName, frequency, unit)` and
  `eventsList(eventName, unit)`; one table per channel (`value`, or `value1..value4` =
  FL, FR, RL, RR) and one `(ts, value)` table per event. Names are always discovered
  from the index tables, and rates are read from `channelsList` because players can
  change them in `UserData/Telemetry/config.json`.
- `GPS Time` (100 Hz) holds the session time of each master sample; a channel at *f* Hz
  lines up with master sample *i* at row *i·f/100*. Events are written on change, with
  `ts` in session time.
- Laps run from one `Lap` event to the next. The official time is the `Lap Time` event
  at the finish (0 = invalid). Counter 0 is the out-lap (practice) or formation + first
  lap (race). `Last Sector1/2` are cumulative splits.
- `Lap Dist` (m) wraps at the line. GPS lat/lon are synthetic but keep the track shape;
  there is no world x/y/z and no yaw rate.
- `G Force Long` holds **lateral** g (+ left) and `G Force Lat` holds **longitudinal** g
  (+ braking). `Steering Pos` is % of lock, + right; it is mapped to a nominal ±270°
  with iRacing's sign (+ left).
- A missing optional channel becomes `null` points plus a warning. A missing
  `GPS Time` / `Lap Dist` throws `LmuParseError`.

### Live Telemetry

```typescript
import { createIRSDK } from '@hotlap.ai/telemetry';

const ir = createIRSDK();

// Connect to iRacing
const connected = await ir.startup();
if (!connected) {
  console.error('Failed to connect to iRacing');
  process.exit(1);
}

// Read live telemetry
setInterval(() => {
  if (ir.isConnected) {
    ir.freezeVarBufferLatest();

    const speed = ir.get('Speed');
    const rpm = ir.get('RPM');
    const gear = ir.get('Gear');

    console.log(`Speed: ${speed}, RPM: ${rpm}, Gear: ${gear}`);

    ir.unfreezeVarBufferLatest();
  }
}, 16); // ~60Hz

// Cleanup on exit
process.on('SIGINT', () => {
  ir.shutdown();
  process.exit(0);
});
```

### WebSocket Telemetry Server

```typescript
import { spawn } from 'bun';

// Start the telemetry server
const server = spawn(['bun', 'run', 'server'], {
  cwd: './node_modules/@hotlap.ai/telemetry',
});

// Connect from client
const ws = new WebSocket('ws://127.0.0.1:32100/ws');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'session_info':
      console.log(`Track: ${msg.data.trackDisplayName}`);
      break;
    case 'telemetry':
      console.log(`Speed: ${msg.data.speed}`);
      break;
    case 'lap_change':
      console.log(`Lap ${msg.data.fromLap} completed: ${msg.data.lapTime}`);
      break;
  }
};
```

## API Reference

### IBT Class

Parse and read iRacing telemetry binary files.

| Method | Description |
|--------|-------------|
| `open(path)` | Open an IBT file asynchronously |
| `get(varName, tick)` | Get a telemetry value at a specific tick |
| `getAll(varName)` | Get all values for a telemetry variable |
| `getSessionInfo(key)` | Get parsed session info by key |
| `getRawSessionInfo()` | Get raw YAML session info string |

| Property | Description |
|----------|-------------|
| `recordCount` | Number of telemetry records |
| `sessionLapCount` | Number of laps in session |
| `tickRate` | Telemetry sample rate (typically 60Hz) |
| `varHeaderNames` | List of available telemetry variables |

### IRSDK Class

Connect to iRacing and read live telemetry data.

| Method | Description |
|--------|-------------|
| `startup()` | Connect to iRacing shared memory |
| `shutdown()` | Disconnect and cleanup |
| `get(varName)` | Get current value of a telemetry variable |
| `getSessionInfo(key)` | Get parsed session info by key |
| `freezeVarBufferLatest()` | Freeze telemetry buffer for consistent reads |
| `unfreezeVarBufferLatest()` | Unfreeze telemetry buffer |

| Property | Description |
|----------|-------------|
| `isConnected` | Whether connected to iRacing |
| `isInitialized` | Whether SDK is initialized |
| `sessionInfoUpdate` | Session info update counter |

### Broadcast Commands

Control iRacing camera, replay, and more:

```typescript
ir.camSwitchPos(position, group, camera);
ir.camSwitchNum(carNumber, group, camera);
ir.replaySetPlaySpeed(speed, slowMotion);
ir.replaySearch(searchMode);
ir.chatCommand(chatCommandMode);
ir.pitCommand(pitCommandMode, variable);
```

## Common Telemetry Variables

| Variable | Type | Description |
|----------|------|-------------|
| `Speed` | float | Vehicle speed (m/s) |
| `RPM` | float | Engine RPM |
| `Gear` | int | Current gear (-1=R, 0=N, 1-6=gears) |
| `Throttle` | float | Throttle position (0-1) |
| `Brake` | float | Brake position (0-1) |
| `Clutch` | float | Clutch position (0-1) |
| `SteeringWheelAngle` | float | Steering angle (radians) |
| `Lap` | int | Current lap number |
| `LapDistPct` | float | Lap completion percentage (0-1) |
| `LapCurrentLapTime` | float | Current lap time (seconds) |
| `SessionTime` | float | Session time (seconds) |
| `FuelLevel` | float | Fuel remaining (liters) |
| `OilTemp` | float | Oil temperature (C) |
| `WaterTemp` | float | Water temperature (C) |

See [iRacing documentation](https://www.iracing.com/) for the complete list of variables.

## Scripts

```bash
bun run build        # Build the library
bun run build:server # Build standalone telemetry server executable
bun run server       # Run telemetry WebSocket server
bun run dev          # Run CLI in watch mode
bun run test         # Run tests
bun run bench        # Run benchmarks
```

## License

MIT - see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
