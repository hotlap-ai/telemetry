#!/usr/bin/env bun

import { createIRSDK } from './live';

const ir = createIRSDK();

console.log('Connecting to iRacing...');
const connected = await ir.startup();

if (!connected) {
  console.error('Failed to connect to iRacing. Make sure iRacing is running.');
  process.exit(1);
}

console.log('Connected to iRacing!');

const telemetryVars = [
  'Speed',
  'RPM',
  'Gear',
  'Throttle',
  'Brake',
  'Clutch',
  'SteeringWheelAngle',
  'Lap',
  'LapCurrentLapTime',
  'LapLastLapTime',
  'LapBestLapTime',
  'LapDeltaToBestLap',
  'LapDistPct',
  'FuelLevel',
  'FuelLevelPct',
  'FuelUsePerHour',
  'OilTemp',
  'WaterTemp',
  'SessionTime',
  'SessionTimeRemain',
  'IsOnTrack',
  'PlayerCarPosition',
  'PlayerCarClassPosition',
  'EngineWarnings',
  'dcBrakeBias',
  'dcTractionControl',
  'dcABS',
];

const sessionInfo = ir.getSessionInfo<{
  TrackName?: string;
  TrackDisplayName?: string;
}>('WeekendInfo');

const driverInfo = ir.getSessionInfo<{
  Drivers?: Array<{ UserName?: string; CarScreenName?: string; CarNumber?: string }>;
  DriverCarIdx?: number;
}>('DriverInfo');

const staticData = {
  track: sessionInfo?.TrackDisplayName || sessionInfo?.TrackName || 'Unknown Track',
  driver: driverInfo?.Drivers?.[driverInfo?.DriverCarIdx ?? 0]?.UserName || 'Unknown Driver',
  car: driverInfo?.Drivers?.[driverInfo?.DriverCarIdx ?? 0]?.CarScreenName || 'Unknown Car',
  carNumber: driverInfo?.Drivers?.[driverInfo?.DriverCarIdx ?? 0]?.CarNumber || '0',
};

console.log(`Track: ${staticData.track}`);
console.log(`Driver: ${staticData.driver}`);
console.log(`Car: ${staticData.car} #${staticData.carNumber}`);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iRacing Live Telemetry</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      padding: 20px;
    }
    .header {
      text-align: center;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid #333;
    }
    .header h1 { font-size: 24px; color: #ff6b00; }
    .header .meta { color: #888; font-size: 14px; margin-top: 8px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .card {
      background: #1a1a1a;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #333;
    }
    .card h2 {
      font-size: 14px;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 15px;
    }
    .big-number {
      font-size: 72px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .unit { font-size: 24px; color: #666; margin-left: 5px; }
    .gauge-container {
      margin-top: 15px;
    }
    .gauge-bar {
      height: 8px;
      background: #333;
      border-radius: 4px;
      overflow: hidden;
    }
    .gauge-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.05s ease-out;
    }
    .gauge-fill.throttle { background: linear-gradient(90deg, #22c55e, #16a34a); }
    .gauge-fill.brake { background: linear-gradient(90deg, #ef4444, #dc2626); }
    .gauge-fill.rpm { background: linear-gradient(90deg, #3b82f6, #f59e0b, #ef4444); }
    .gauge-fill.fuel { background: linear-gradient(90deg, #f59e0b, #22c55e); }
    .pedals {
      display: flex;
      gap: 20px;
      align-items: flex-end;
      height: 200px;
    }
    .pedal {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .pedal-bar {
      width: 100%;
      height: 180px;
      background: #333;
      border-radius: 8px;
      position: relative;
      overflow: hidden;
    }
    .pedal-fill {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      transition: height 0.03s ease-out;
      border-radius: 8px;
    }
    .pedal-fill.throttle { background: linear-gradient(0deg, #16a34a, #22c55e); }
    .pedal-fill.brake { background: linear-gradient(0deg, #dc2626, #ef4444); }
    .pedal-fill.clutch { background: linear-gradient(0deg, #2563eb, #3b82f6); }
    .pedal-label { margin-top: 8px; color: #888; font-size: 12px; }
    .pedal-value { font-size: 18px; font-weight: 600; margin-top: 4px; }
    .gear-display {
      text-align: center;
    }
    .gear {
      font-size: 120px;
      font-weight: 800;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .gear.neutral { color: #888; }
    .gear.reverse { color: #ef4444; }
    .lap-times {
      display: grid;
      gap: 15px;
    }
    .lap-time {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .lap-time .label { color: #888; }
    .lap-time .value {
      font-size: 24px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .lap-time .value.best { color: #a855f7; }
    .lap-time .value.last { color: #22c55e; }
    .lap-time .value.current { color: #f59e0b; }
    .delta {
      font-size: 48px;
      font-weight: 700;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .delta.positive { color: #ef4444; }
    .delta.negative { color: #22c55e; }
    .delta.neutral { color: #888; }
    .status-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #333;
    }
    .status-row:last-child { border-bottom: none; }
    .status-row .label { color: #888; }
    .status-row .value { font-weight: 600; font-variant-numeric: tabular-nums; }
    .steering-wheel {
      width: 150px;
      height: 150px;
      border: 8px solid #444;
      border-radius: 50%;
      margin: 0 auto;
      position: relative;
      transition: transform 0.03s ease-out;
    }
    .steering-marker {
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      width: 4px;
      height: 20px;
      background: #ff6b00;
      border-radius: 2px;
    }
    .connection-status {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
    }
    .connection-status.connected { background: #16a34a; }
    .connection-status.disconnected { background: #dc2626; }
    .position {
      font-size: 48px;
      font-weight: 700;
      text-align: center;
    }
    .position .suffix { font-size: 24px; color: #888; }
  </style>
</head>
<body>
  <div class="connection-status" id="connStatus">Connecting...</div>

  <div class="header">
    <h1>iRacing Live Telemetry</h1>
    <div class="meta">
      <span id="track">${staticData.track}</span> &bull;
      <span id="driver">${staticData.driver}</span> &bull;
      <span id="car">${staticData.car}</span> #<span id="carNumber">${staticData.carNumber}</span>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Speed</h2>
      <div class="big-number"><span id="speed">0</span><span class="unit">km/h</span></div>
    </div>

    <div class="card">
      <h2>RPM</h2>
      <div class="big-number"><span id="rpm">0</span></div>
      <div class="gauge-container">
        <div class="gauge-bar">
          <div class="gauge-fill rpm" id="rpmBar" style="width: 0%"></div>
        </div>
      </div>
    </div>

    <div class="card gear-display">
      <h2>Gear</h2>
      <div class="gear" id="gear">N</div>
    </div>

    <div class="card">
      <h2>Pedals</h2>
      <div class="pedals">
        <div class="pedal">
          <div class="pedal-bar">
            <div class="pedal-fill throttle" id="throttleBar"></div>
          </div>
          <div class="pedal-label">Throttle</div>
          <div class="pedal-value" id="throttle">0%</div>
        </div>
        <div class="pedal">
          <div class="pedal-bar">
            <div class="pedal-fill brake" id="brakeBar"></div>
          </div>
          <div class="pedal-label">Brake</div>
          <div class="pedal-value" id="brake">0%</div>
        </div>
        <div class="pedal">
          <div class="pedal-bar">
            <div class="pedal-fill clutch" id="clutchBar"></div>
          </div>
          <div class="pedal-label">Clutch</div>
          <div class="pedal-value" id="clutch">0%</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Lap Times</h2>
      <div class="lap-times">
        <div class="lap-time">
          <span class="label">Current</span>
          <span class="value current" id="currentLap">--:--.---</span>
        </div>
        <div class="lap-time">
          <span class="label">Last Lap</span>
          <span class="value last" id="lastLap">--:--.---</span>
        </div>
        <div class="lap-time">
          <span class="label">Best Lap</span>
          <span class="value best" id="bestLap">--:--.---</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Delta to Best</h2>
      <div class="delta neutral" id="delta">+0.000</div>
    </div>

    <div class="card">
      <h2>Position</h2>
      <div class="position">
        P<span id="position">-</span>
      </div>
    </div>

    <div class="card">
      <h2>Steering</h2>
      <div class="steering-wheel" id="wheel">
        <div class="steering-marker"></div>
      </div>
    </div>

    <div class="card">
      <h2>Fuel</h2>
      <div class="big-number"><span id="fuel">0.0</span><span class="unit">L</span></div>
      <div class="gauge-container">
        <div class="gauge-bar">
          <div class="gauge-fill fuel" id="fuelBar" style="width: 0%"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Car Status</h2>
      <div class="status-row">
        <span class="label">Lap</span>
        <span class="value" id="lapNum">0</span>
      </div>
      <div class="status-row">
        <span class="label">Track %</span>
        <span class="value" id="trackPct">0%</span>
      </div>
      <div class="status-row">
        <span class="label">Oil Temp</span>
        <span class="value" id="oilTemp">0°C</span>
      </div>
      <div class="status-row">
        <span class="label">Water Temp</span>
        <span class="value" id="waterTemp">0°C</span>
      </div>
      <div class="status-row">
        <span class="label">Fuel Use/Hr</span>
        <span class="value" id="fuelUse">0 L/h</span>
      </div>
    </div>
  </div>

  <script>
    const ws = new WebSocket('ws://' + location.host + '/ws');
    const connStatus = document.getElementById('connStatus');

    ws.onopen = () => {
      connStatus.textContent = 'Connected';
      connStatus.className = 'connection-status connected';
    };

    ws.onclose = () => {
      connStatus.textContent = 'Disconnected';
      connStatus.className = 'connection-status disconnected';
    };

    ws.onerror = () => {
      connStatus.textContent = 'Error';
      connStatus.className = 'connection-status disconnected';
    };

    function formatLapTime(seconds) {
      if (!seconds || seconds < 0 || seconds > 3600) return '--:--.---';
      const mins = Math.floor(seconds / 60);
      const secs = (seconds % 60).toFixed(3).padStart(6, '0');
      return mins + ':' + secs;
    }

    function formatDelta(delta) {
      if (delta === null || delta === undefined || Math.abs(delta) > 999) return '+0.000';
      const sign = delta >= 0 ? '+' : '';
      return sign + delta.toFixed(3);
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Speed (m/s to km/h)
      const speedKmh = Math.round((data.Speed || 0) * 3.6);
      document.getElementById('speed').textContent = speedKmh;

      // RPM
      const rpm = Math.round(data.RPM || 0);
      document.getElementById('rpm').textContent = rpm;
      const rpmPct = Math.min(100, (rpm / 8000) * 100);
      document.getElementById('rpmBar').style.width = rpmPct + '%';

      // Gear
      const gear = data.Gear;
      const gearEl = document.getElementById('gear');
      if (gear === 0) {
        gearEl.textContent = 'N';
        gearEl.className = 'gear neutral';
      } else if (gear === -1) {
        gearEl.textContent = 'R';
        gearEl.className = 'gear reverse';
      } else {
        gearEl.textContent = gear;
        gearEl.className = 'gear';
      }

      // Pedals
      const throttle = Math.round((data.Throttle || 0) * 100);
      const brake = Math.round((data.Brake || 0) * 100);
      const clutch = Math.round((data.Clutch || 0) * 100);

      document.getElementById('throttle').textContent = throttle + '%';
      document.getElementById('brake').textContent = brake + '%';
      document.getElementById('clutch').textContent = clutch + '%';
      document.getElementById('throttleBar').style.height = throttle + '%';
      document.getElementById('brakeBar').style.height = brake + '%';
      document.getElementById('clutchBar').style.height = clutch + '%';

      // Lap times
      document.getElementById('currentLap').textContent = formatLapTime(data.LapCurrentLapTime);
      document.getElementById('lastLap').textContent = formatLapTime(data.LapLastLapTime);
      document.getElementById('bestLap').textContent = formatLapTime(data.LapBestLapTime);

      // Delta
      const delta = data.LapDeltaToBestLap;
      const deltaEl = document.getElementById('delta');
      deltaEl.textContent = formatDelta(delta);
      if (delta > 0.05) {
        deltaEl.className = 'delta positive';
      } else if (delta < -0.05) {
        deltaEl.className = 'delta negative';
      } else {
        deltaEl.className = 'delta neutral';
      }

      // Position
      document.getElementById('position').textContent = data.PlayerCarPosition || '-';

      // Steering
      const steerAngle = (data.SteeringWheelAngle || 0) * (180 / Math.PI);
      document.getElementById('wheel').style.transform = 'rotate(' + (-steerAngle) + 'deg)';

      // Fuel
      const fuel = (data.FuelLevel || 0).toFixed(1);
      const fuelPct = (data.FuelLevelPct || 0) * 100;
      document.getElementById('fuel').textContent = fuel;
      document.getElementById('fuelBar').style.width = fuelPct + '%';

      // Status
      document.getElementById('lapNum').textContent = data.Lap || 0;
      document.getElementById('trackPct').textContent = Math.round((data.LapDistPct || 0) * 100) + '%';
      document.getElementById('oilTemp').textContent = Math.round(data.OilTemp || 0) + '°C';
      document.getElementById('waterTemp').textContent = Math.round(data.WaterTemp || 0) + '°C';
      document.getElementById('fuelUse').textContent = (data.FuelUsePerHour || 0).toFixed(1) + ' L/h';
    };
  </script>
</body>
</html>`;

const server = Bun.serve({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws' || req.headers.get('upgrade') === 'websocket') {
      const success = server.upgrade(req);
      if (success) {
        return undefined;
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      console.log('Dashboard client connected');
      ws.subscribe('telemetry');
    },
    close(ws) {
      console.log('Dashboard client disconnected');
    },
    message(ws, msg) {},
  },
});

console.log(`\nDashboard running at http://localhost:${server.port}`);
console.log('Open this URL in your browser to see live telemetry\n');

let lastTick = 0;

setInterval(() => {
  if (!ir.isConnected) {
    console.log('Waiting for iRacing connection...');
    return;
  }

  ir.freezeVarBufferLatest();

  const data: Record<string, unknown> = {};
  for (const v of telemetryVars) {
    data[v] = ir.get(v);
  }

  ir.unfreezeVarBufferLatest();

  server.publish('telemetry', JSON.stringify(data));
}, 1000 / 60); // 60Hz

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  ir.shutdown();
  process.exit(0);
});
