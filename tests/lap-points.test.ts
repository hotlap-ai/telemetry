/**
 * Tests for the canonical lap point extraction (src/lap-points.ts).
 *
 * Output shape/conversions are anchored to the deployed references:
 * UI/src/lib/ibt-extract.ts and the backend process-job convertToIbtLapData
 * (tire wear canonically 0–100 %, the process-job/stored-bundle convention).
 *
 * Sample .ibt files live in tests/fixtures/files (or IBT_SAMPLES_DIR);
 * golden tests skip gracefully when absent.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IBT } from '../src/ibt';
import { normalizeIbt, type IbtSource } from '../src/normalize';
import { extractLapPoints } from '../src/lap-points';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures', 'files');
const SAMPLES_DIR =
  process.env.IBT_SAMPLES_DIR ??
  (existsSync(FIXTURES_DIR) ? FIXTURES_DIR
    : 'C:/Users/sergi/DEV/hotlap.ai/hotlap.ai/UI/public/telemetry');

const IMOLA = 'acuransxevo22gt3_imola gp 2025-12-22 23-27-46.ibt';
const available = existsSync(join(SAMPLES_DIR, IMOLA));

describe('extractLapPoints — synthetic source (no fixtures required)', () => {
  /**
   * 60 Hz constant-speed car on a 1.00 km track, 60 s per lap → exactly
   * 60 km/h. Laps: 0 (out-lap tail), 1, 2 complete, 3 partial.
   * Channel values chosen so every conversion has a known expected output.
   */
  function syntheticSource(opts?: { carcassTempsOnly?: boolean }): IbtSource {
    const HZ = 60;
    const LAP_SEC = 60;
    const OUT_SAMPLES = 30;
    const LAP3_SAMPLES = 20 * HZ;
    const total = OUT_SAMPLES + 2 * LAP_SEC * HZ + LAP3_SAMPLES;

    const lap = new Int32Array(total);
    const time = new Float64Array(total);
    const pct = new Float32Array(total);
    const dist = new Float32Array(total);
    const sess = new Int32Array(total);
    let i = 0;
    for (let k = 0; k < OUT_SAMPLES; k++, i++) {
      lap[i] = 0;
      time[i] = k / HZ;
      pct[i] = 0.995 + (0.005 * k) / OUT_SAMPLES;
      dist[i] = 995 + (5 * k) / OUT_SAMPLES;
      sess[i] = 0;
    }
    const t0 = OUT_SAMPLES / HZ;
    for (let lapNo = 1; lapNo <= 2; lapNo++) {
      for (let k = 0; k < LAP_SEC * HZ; k++, i++) {
        lap[i] = lapNo;
        time[i] = t0 + (lapNo - 1) * LAP_SEC + k / HZ;
        pct[i] = k / (LAP_SEC * HZ);
        dist[i] = (1000 * k) / (LAP_SEC * HZ);
        sess[i] = 0;
      }
    }
    for (let k = 0; k < LAP3_SAMPLES; k++, i++) {
      lap[i] = 3;
      time[i] = t0 + 2 * LAP_SEC + k / HZ;
      pct[i] = k / (LAP_SEC * HZ);
      dist[i] = (1000 * k) / (LAP_SEC * HZ);
      sess[i] = 0;
    }

    const constant = (v: number) => new Float32Array(total).fill(v);
    const SPEED_MS = 1000 / LAP_SEC; // 16.667 m/s = exactly 60 km/h
    const gear = new Int32Array(total).fill(3);

    const channels: Record<string, Float32Array | Float64Array | Int32Array> = {
      Lap: lap, SessionTime: time, LapDistPct: pct, LapDist: dist, SessionNum: sess,
      Speed: constant(SPEED_MS),
      Throttle: constant(0.5),
      Brake: constant(0.25),
      Gear: gear,
      RPM: constant(5000),
      SteeringWheelAngle: constant(Math.PI / 2), // → 90°
      Lat: constant(44.34),
      Lon: constant(11.71),
      Alt: constant(37.5),
      LFpressure: constant(165), RFpressure: constant(166),
      LRpressure: constant(167), RRpressure: constant(168),
      LFwearM: constant(0.9), RFwearM: constant(0.91),
      LRwearM: constant(0.92), RRwearM: constant(0.93),
    };
    if (opts?.carcassTempsOnly) {
      channels['LFtempCM'] = constant(81);
      channels['RFtempCM'] = constant(82);
      channels['LRtempCM'] = constant(83);
      channels['RRtempCM'] = constant(84);
    } else {
      channels['LFtempM'] = constant(71);
      channels['RFtempM'] = constant(72);
      channels['LRtempM'] = constant(73);
      channels['RRtempM'] = constant(74);
    }

    // Bool channel: only reachable via getAll (typed path returns null),
    // exactly like the real IBT class for type-1 channels.
    const abs = new Array<boolean>(total);
    for (let k = 0; k < total; k++) abs[k] = k % 2 === 0;

    return {
      tickRate: HZ,
      recordCount: total,
      getAllTyped: (key) => channels[key] ?? null,
      getAll: (key) => {
        if (key === 'BrakeABSactive') return abs;
        return channels[key] ? Array.from(channels[key]!) : null;
      },
      getSessionInfo: <T,>(key?: string) => {
        const root = {
          WeekendInfo: { TrackLength: '1.00 km', EventType: 'Test', TrackDisplayName: 'Synthetic Ring' },
          SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: 'Offline Testing' }] },
          DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, UserName: 'Synth Driver' }] },
        };
        return (key ? (root as Record<string, unknown>)[key] : root) as T;
      },
    };
  }

  function lap1Points(opts?: { maxPoints?: number }) {
    const source = syntheticSource();
    const laps = new Map(normalizeIbt(source)[0]!.laps.map((l) => [l.lapNumber, l]));
    return extractLapPoints(source, laps.get(1)!, opts);
  }

  test('unit conversions match the IbtLapPoint contract', () => {
    const { byDist } = lap1Points();
    expect(byDist.length).toBeGreaterThan(0);
    const p = byDist[0]!;

    expect(p.distanceKm).toBeCloseTo(0, 6); // min-dist normalized
    expect(p.timeSec).toBeCloseTo(0, 6); // min-time normalized
    expect(p.speedKmh!).toBeCloseTo(60, 3); // m/s → km/h
    expect(p.throttlePct!).toBeCloseTo(50, 5); // 0–1 → %
    expect(p.brakePct!).toBeCloseTo(25, 5);
    expect(p.steeringDeg!).toBeCloseTo(90, 4); // rad → deg
    expect(p.gear).toBe(3);
    expect(p.rpm!).toBeCloseTo(5000, 3);
    expect(p.lat!).toBeCloseTo(44.34, 4);
    expect(p.lon!).toBeCloseTo(11.71, 4);
    expect(p.altitudeM!).toBeCloseTo(37.5, 4);
    expect(p.tireTempLF!).toBeCloseTo(71, 4);
    expect(p.tireTempRR!).toBeCloseTo(74, 4);
    expect(p.tirePressureLF!).toBeCloseTo(165, 3);
    // CANONICAL: wear is percent 0–100 (process-job / stored-bundle behavior).
    expect(p.tireWearLF!).toBeCloseTo(90, 4);
    expect(p.tireWearRR!).toBeCloseTo(93, 4);
  });

  test('BrakeABSactive comes through the bool getAll path as boolean|null', () => {
    const { byTime } = lap1Points({ maxPoints: 100000 });
    // Alternating true/false in the source → both present, all booleans.
    const values = new Set(byTime.map((p) => p.brakeABSactive));
    expect(values.has(true)).toBe(true);
    expect(values.has(false)).toBe(true);
    expect(values.has(null)).toBe(false);
  });

  test('tire temps fall back to carcass channels (LFtempCM..) when surface absent', () => {
    const source = syntheticSource({ carcassTempsOnly: true });
    const laps = new Map(normalizeIbt(source)[0]!.laps.map((l) => [l.lapNumber, l]));
    const { byDist } = extractLapPoints(source, laps.get(1)!, {});
    expect(byDist[0]!.tireTempLF!).toBeCloseTo(81, 4);
    expect(byDist[0]!.tireTempRR!).toBeCloseTo(84, 4);
  });

  test('sort orders: byDist ascending by distanceKm, byTime ascending by timeSec', () => {
    const { byDist, byTime } = lap1Points();
    for (let i = 1; i < byDist.length; i++) {
      expect(byDist[i]!.distanceKm).toBeGreaterThanOrEqual(byDist[i - 1]!.distanceKm);
    }
    for (let i = 1; i < byTime.length; i++) {
      expect(byTime[i]!.timeSec).toBeGreaterThanOrEqual(byTime[i - 1]!.timeSec);
    }
  });

  test('downsampling honors maxPoints and reports downsampledFrom', () => {
    // Lap 1 has exactly 3600 samples at full resolution.
    const dflt = lap1Points();
    expect(dflt.downsampledFrom).toBe(3600);
    expect(dflt.byDist.length).toBeLessThanOrEqual(500);
    expect(dflt.byTime.length).toBeLessThanOrEqual(500);
    // stride = ceil(3600/500) = 8 → 450 points kept.
    expect(dflt.byDist.length).toBe(450);
    expect(dflt.byTime.length).toBe(450);

    const small = lap1Points({ maxPoints: 100 });
    expect(small.byDist.length).toBe(100); // ceil(3600/100)=36 → exactly 100
    expect(small.downsampledFrom).toBe(3600);

    // maxPoints above the sample count → no downsampling at all.
    const full = lap1Points({ maxPoints: 100000 });
    expect(full.byDist.length).toBe(3600);
    expect(full.byTime.length).toBe(3600);
    expect(full.downsampledFrom).toBe(3600);
  });

  test('lap span end-to-end: full-res extremes survive downsampling at index 0', () => {
    const { byDist, byTime } = lap1Points();
    // index 0 of each ordering is always kept by i % stride === 0.
    expect(byDist[0]!.distanceKm).toBeCloseTo(0, 6);
    expect(byTime[0]!.timeSec).toBeCloseTo(0, 6);
    // Last kept point is within one stride (8 samples ≈ 0.133 s / ~2.2 m) of the end.
    expect(byDist[byDist.length - 1]!.distanceKm).toBeGreaterThan(0.99 - 0.005);
    expect(byTime[byTime.length - 1]!.timeSec).toBeGreaterThan(60 - 1 / 60 - 0.14);
  });
});

describe.skipIf(!available)('extractLapPoints — golden Imola sample', () => {
  test('lap 2 point series matches the stored-bundle contract', async () => {
    const bytes = await Bun.file(join(SAMPLES_DIR, IMOLA)).arrayBuffer();
    const ibt = await IBT.fromBuffer(bytes);
    try {
      const sessions = normalizeIbt(ibt);
      const s = sessions[0]!;
      const lap2 = s.laps.find((l) => l.lapNumber === 2)!;
      expect(lap2.completed).toBe(true);

      const { byDist, byTime, downsampledFrom } = extractLapPoints(ibt, lap2);

      // Downsampling cap and provenance.
      expect(byDist.length).toBeGreaterThan(100);
      expect(byDist.length).toBeLessThanOrEqual(500);
      expect(byTime.length).toBeLessThanOrEqual(500);
      expect(downsampledFrom).toBeGreaterThanOrEqual(byDist.length);
      expect(downsampledFrom).toBeLessThanOrEqual(lap2.sampleCount);

      // Distance axis: starts at ~0, ends within 50 m of the lap's distance.
      expect(byDist[0]!.distanceKm).toBeCloseTo(0, 6);
      const lastDist = byDist[byDist.length - 1]!.distanceKm;
      expect(Math.abs(lastDist - lap2.distanceKm)).toBeLessThan(0.05);

      // Speeds within a sane GT3 range.
      for (const p of byDist) {
        if (p.speedKmh != null) {
          expect(p.speedKmh).toBeGreaterThanOrEqual(-1);
          expect(p.speedKmh).toBeLessThan(320);
        }
      }
      const topSpeed = Math.max(...byDist.map((p) => p.speedKmh ?? 0));
      expect(topSpeed).toBeGreaterThan(150); // a GT3 lap definitely exceeds this

      // Time axis: last point within 0.2 s of the lap's sample span.
      const lastTime = byTime[byTime.length - 1]!.timeSec;
      expect(byTime[0]!.timeSec).toBeCloseTo(0, 6);
      expect(Math.abs(lap2.sampleSpanSec - lastTime)).toBeLessThan(0.2);
    } finally {
      ibt.close();
    }
  });
});
