# @hotlap.ai/telemetry

High-performance iRacing telemetry SDK for [Bun](https://bun.sh). Parse IBT telemetry files and stream live data from iRacing via Windows shared memory.

## Features

- **IBT File Parsing** - Read and analyze iRacing telemetry binary files (.ibt)
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

See iRacing SDK documentation for the complete list of variables.

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
