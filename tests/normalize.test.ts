/**
 * Golden tests for the canonical normalizer (RFC-0001).
 *
 * Expected values are externally anchored where possible:
 *  - LapLastLapTime values were independently verified against Garage 61
 *    exports and iRacing official results for two production subsessions
 *    (RFC Appendix B); for the local sample files below they were read
 *    directly from the sim's channel by two independent implementations
 *    (this package and the hotlap.ai diff-harness probe).
 *
 * Sample .ibt files live outside this repo (hotlap.ai app repo). Tests skip
 * gracefully when the directory is absent (CI without fixtures).
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IBT } from '../src/ibt';
import { normalizeIbt, type IbtSource, type NormalizedSession } from '../src/normalize';

const SAMPLES_DIR =
  process.env.IBT_SAMPLES_DIR ??
  'C:/Users/sergi/DEV/hotlap.ai/hotlap.ai/UI/public/telemetry';

const FILES = {
  imola: 'acuransxevo22gt3_imola gp 2025-12-22 23-27-46.ibt',
  roadAtlanta: 'acuransxevo22gt3_roadatlanta full 2025-12-23 12-27-07.ibt',
  vir: 'acuransxevo22gt3_virginia 2022 full 2025-12-20 22-57-02.ibt',
  formulaVee: 'formulavee_miami gp 2025-12-26 18-54-31.ibt',
};

const available = existsSync(join(SAMPLES_DIR, FILES.imola));

async function normalize(file: string): Promise<NormalizedSession[]> {
  const bytes = await Bun.file(join(SAMPLES_DIR, file)).arrayBuffer();
  const ibt = await IBT.fromBuffer(bytes);
  const sessions = normalizeIbt(ibt);
  ibt.close();
  return sessions;
}

function lapsByNumber(s: NormalizedSession) {
  return new Map(s.laps.map((l) => [l.lapNumber, l]));
}

describe('normalizeIbt — synthetic source (no fixtures required)', () => {
  /**
   * 60 Hz constant-speed car on a 1.00 km track, 60 s per lap.
   * Laps: 0 (out-lap tail), 1, 2 (complete), 3 (recording stops mid-lap).
   * NO LapLastLapTime channel → exercises the RFC C2 crossing-interpolation
   * fallback for a file whose sim-clock channel is absent.
   */
  function syntheticSource(): IbtSource {
    const HZ = 60;
    const LAP_SEC = 60;
    const OUT_SAMPLES = 30;           // half a second of lap 0
    const LAP3_SAMPLES = 20 * HZ;     // 20s into lap 3
    const total = OUT_SAMPLES + 2 * LAP_SEC * HZ + LAP3_SAMPLES;
    const lap = new Int32Array(total);
    const time = new Float64Array(total);
    const pct = new Float32Array(total);
    const dist = new Float32Array(total);
    const sess = new Int32Array(total);
    let i = 0;
    // lap 0: pct 0.995 → 1.0 (approaching the line)
    for (let k = 0; k < OUT_SAMPLES; k++, i++) {
      lap[i] = 0;
      time[i] = k / HZ;
      pct[i] = 0.995 + (0.005 * k) / OUT_SAMPLES;
      dist[i] = 995 + (5 * k) / OUT_SAMPLES;
      sess[i] = 0;
    }
    const t0 = OUT_SAMPLES / HZ; // crossing at exactly t0
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
    const channels: Record<string, Float32Array | Float64Array | Int32Array> = {
      Lap: lap, SessionTime: time, LapDistPct: pct, LapDist: dist, SessionNum: sess,
    };
    return {
      tickRate: HZ,
      recordCount: total,
      getAllTyped: (key) => channels[key] ?? null,
      getAll: (key) => (channels[key] ? Array.from(channels[key]!) : null),
      getSessionInfo: <T,>(key?: string) => {
        const root = {
          WeekendInfo: { TrackLength: '1.00 km', EventType: 'Test', TrackDisplayName: 'Synthetic Ring' },
          SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: 'Offline Testing' }] },
          SplitTimeInfo: { Sectors: [
            { SectorNum: 0, SectorStartPct: 0 },
            { SectorNum: 1, SectorStartPct: 0.5 },
          ] },
          DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, UserName: 'Synth Driver' }] },
        };
        return (key ? (root as Record<string, unknown>)[key] : root) as T;
      },
    };
  }

  test('C2 fallback: crossing interpolation when LapLastLapTime is absent', () => {
    const sessions = normalizeIbt(syntheticSource());
    expect(sessions.length).toBe(1);
    const laps = new Map(sessions[0]!.laps.map((l) => [l.lapNumber, l]));

    for (const lapNo of [1, 2]) {
      const l = laps.get(lapNo)!;
      expect(l.timingSource).toBe('crossing-interpolation');
      expect(l.lapTimeSec!).toBeCloseTo(60, 2);
      expect(l.completed).toBe(true);
      expect(l.flags).toContain('no-lap-last-time');
      // Two YAML sectors → exactly 2 sector times of ~30s each.
      expect(l.sectorTimes.length).toBe(2);
      expect(l.sectorTimes[0]!.timeSec!).toBeCloseTo(30, 1);
      expect(l.sectorTimes[1]!.timeSec!).toBeCloseTo(30, 1);
    }

    // Lap 3: recording stops mid-lap → no finish crossing → incomplete, no time.
    const l3 = laps.get(3)!;
    expect(l3.completed).toBe(false);
    expect(l3.lapTimeSec).toBeNull();

    // Lap 0 is an out-lap, never completed.
    expect(laps.get(0)!.completed).toBe(false);
    expect(laps.get(0)!.flags).toContain('out-lap');
  });

  test('mid-lap-start recording: no fabricated time without a start crossing', () => {
    // Recording begins at lap 1, pct 0.30 — no wrap into lap 1 exists.
    const HZ = 60;
    const lap1Samples = 42 * HZ; // pct 0.30 → 1.0 at constant speed
    const lap2Samples = 60 * HZ;
    const total = lap1Samples + lap2Samples;
    const lap = new Int32Array(total);
    const time = new Float64Array(total);
    const pct = new Float32Array(total);
    let i = 0;
    for (let k = 0; k < lap1Samples; k++, i++) {
      lap[i] = 1; time[i] = k / HZ; pct[i] = 0.3 + (0.7 * k) / lap1Samples;
    }
    for (let k = 0; k < lap2Samples; k++, i++) {
      lap[i] = 2; time[i] = 42 + k / HZ; pct[i] = k / lap2Samples;
    }
    const channels: Record<string, Float64Array | Float32Array | Int32Array> = {
      Lap: lap, SessionTime: time, LapDistPct: pct,
    };
    const src: IbtSource = {
      tickRate: HZ, recordCount: total,
      getAllTyped: (key) => channels[key] ?? null,
      getAll: (key) => (channels[key] ? Array.from(channels[key]!) : null),
      getSessionInfo: <T,>(key?: string) => {
        const root = { WeekendInfo: { EventType: 'Test' } };
        return (key ? (root as Record<string, unknown>)[key] : root) as T;
      },
    };

    const laps = new Map(normalizeIbt(src)[0]!.laps.map((l) => [l.lapNumber, l]));
    const l1 = laps.get(1)!;
    // The first sample is NOT a line crossing — timing must refuse to derive.
    expect(l1.lapTimeSec).toBeNull();
    expect(l1.completed).toBe(false);
  });

  test('LapLastLapTime present but recording ends inside the update lag (RFC C2 grace)', () => {
    // Laps 1 and 2 complete; recording stops 0.5s into lap 3, before the sim
    // published lap 2's time. Lap 2 must fall back to crossing interpolation.
    const HZ = 60;
    const lapSamples = 60 * HZ;
    const lap3Samples = Math.floor(0.5 * HZ);
    const total = 2 * lapSamples + lap3Samples;
    const lap = new Int32Array(total);
    const time = new Float64Array(total);
    const pct = new Float32Array(total);
    const llt = new Float32Array(total);
    let i = 0;
    for (let lapNo = 1; lapNo <= 2; lapNo++) {
      for (let k = 0; k < lapSamples; k++, i++) {
        lap[i] = lapNo;
        time[i] = (lapNo - 1) * 60 + k / HZ;
        pct[i] = k / lapSamples;
        llt[i] = lapNo === 1 ? 0 : 60.0; // lap 1's time appears during lap 2
      }
    }
    for (let k = 0; k < lap3Samples; k++, i++) {
      lap[i] = 3; time[i] = 120 + k / HZ; pct[i] = k / lapSamples;
      llt[i] = 60.0; // update lag: lap 2's time never appears
    }
    const channels: Record<string, Float64Array | Float32Array | Int32Array> = {
      Lap: lap, SessionTime: time, LapDistPct: pct, LapLastLapTime: llt,
    };
    const src: IbtSource = {
      tickRate: HZ, recordCount: total,
      getAllTyped: (key) => channels[key] ?? null,
      getAll: (key) => (channels[key] ? Array.from(channels[key]!) : null),
      getSessionInfo: <T,>(key?: string) => {
        const root = { WeekendInfo: { EventType: 'Test' } };
        return (key ? (root as Record<string, unknown>)[key] : root) as T;
      },
    };

    const laps = new Map(normalizeIbt(src)[0]!.laps.map((l) => [l.lapNumber, l]));
    // Lap 1: scored normally via the channel update seen during lap 2.
    expect(laps.get(1)!.timingSource).toBe('lap-last-lap-time');
    expect(laps.get(1)!.lapTimeSec!).toBeCloseTo(60, 3);
    // Lap 2: update missed within the grace window → crossing fallback.
    const l2 = laps.get(2)!;
    expect(l2.timingSource).toBe('crossing-interpolation');
    expect(l2.lapTimeSec!).toBeCloseTo(60, 2);
    expect(l2.completed).toBe(true);
    // Lap 3 fragment: incomplete, no time.
    expect(laps.get(3)!.completed).toBe(false);
    expect(laps.get(3)!.lapTimeSec).toBeNull();
  });
});

describe.skipIf(!available)('normalizeIbt — golden samples', () => {
  test('Imola GT3: authoritative lap times, 5 sectors, race session resolved', async () => {
    const sessions = await normalize(FILES.imola);
    expect(sessions.length).toBe(1);
    const s = sessions[0]!;

    // C5: SessionNum channel is 2 → the Race session, not Sessions[0] (Practice).
    expect(s.sessionNum).toBe(2);
    expect(s.sessionType).toBe('Race');
    expect(s.eventType).toBe('Race');
    expect(s.trackLengthKm!).toBeGreaterThan(4.8);
    expect(s.trackLengthKm!).toBeLessThan(5.0);

    const laps = lapsByNumber(s);
    // Sim-scored times (LapLastLapTime, cross-checked by the diff-harness probe).
    const expected: Record<number, number> = {
      2: 103.8299, 3: 103.9114, 4: 103.027, 5: 103.8428,
      6: 110.7841, 8: 106.034, 9: 103.8588, 10: 103.4205, 11: 104.8837,
    };
    for (const [lapNo, t] of Object.entries(expected)) {
      const lap = laps.get(Number(lapNo))!;
      expect(lap.completed).toBe(true);
      expect(lap.timingSource).toBe('lap-last-lap-time');
      expect(lap.lapTimeSec!).toBeCloseTo(t, 3);
    }

    // C4: Imola has 5 YAML sectors (0..4) → exactly 5 sector times, numbered 1..5.
    const lap2 = laps.get(2)!;
    expect(lap2.sectorTimes.length).toBe(5);
    expect(lap2.sectorTimes.map((x) => x.sectorNum)).toEqual([1, 2, 3, 4, 5]);
    // No silent rescaling: sectors must genuinely sum to ≈ the official time,
    // and the residual must be a real measurement (a rescaling implementation
    // would force it to floating-point zero).
    expect(Math.abs(lap2.sectorResidualSec!)).toBeLessThan(0.05);
    expect(Math.abs(lap2.sectorResidualSec!)).toBeGreaterThan(1e-6);

    // Final lap (13) is a 4s fragment: never scored → not completed.
    const last = laps.get(13)!;
    expect(last.completed).toBe(false);
    expect(last.lapTimeSec).toBeNull();
  });

  test('Formula Vee Miami: ghost lap 3 is not a completed lap (RFC C3)', async () => {
    const sessions = await normalize(FILES.formulaVee);
    const s = sessions[0]!;

    // C5: "Offline Testing" — full string, not truncated to "Offline".
    expect(s.sessionNum).toBe(0);
    expect(s.sessionType).toBe('Offline Testing');
    expect(s.eventType).toBe('Test');

    const laps = lapsByNumber(s);
    // Scored laps.
    expect(laps.get(2)!.completed).toBe(true);
    expect(laps.get(2)!.lapTimeSec!).toBeCloseTo(347.4581, 3);
    expect(laps.get(4)!.completed).toBe(true);
    expect(laps.get(4)!.lapTimeSec!).toBeCloseTo(279.8023, 3);

    // The 34s "lap 3" both legacy parsers accepted: LapLastLapTime never
    // updated → completed=false, no official time. This is the RFC's
    // headline validity fix.
    const ghost = laps.get(3)!;
    expect(ghost.completed).toBe(false);
    expect(ghost.lapTimeSec).toBeNull();
    expect(ghost.flags).toContain('no-lap-last-time');
  });

  test('VIR GT3: race lap 1 uses the sim clock, not the 326s sample span (RFC C2)', async () => {
    const sessions = await normalize(FILES.vir);
    const s = sessions[0]!;
    expect(s.sessionNum).toBe(2);
    expect(s.sessionType).toBe('Race');

    const laps = lapsByNumber(s);
    const lap1 = laps.get(1)!;
    // Sample span includes ~205s of gridding; the sim scored 121.5419s.
    expect(lap1.sampleSpanSec).toBeGreaterThan(300);
    expect(lap1.lapTimeSec!).toBeCloseTo(121.5419, 3);
    expect(lap1.completed).toBe(true);

    expect(laps.get(2)!.lapTimeSec!).toBeCloseTo(108.1324, 3);
    expect(laps.get(12)!.lapTimeSec!).toBeCloseTo(107.1678, 3);
  });

  test('Road Atlanta GT3: practice session, consistent sector counts on every lap', async () => {
    const sessions = await normalize(FILES.roadAtlanta);
    const s = sessions[0]!;
    expect(s.sessionType).toBe('Practice');

    const laps = lapsByNumber(s);
    expect(laps.get(2)!.lapTimeSec!).toBeCloseTo(81.6726, 3);
    expect(laps.get(6)!.lapTimeSec!).toBeCloseTo(80.1636, 3);

    // C4: sector count must be identical for every completed lap (the deployed
    // backend flapped 5/6 on Road America — RFC Appendix B).
    const counts = new Set(
      s.laps.filter((l) => l.completed).map((l) => l.sectorTimes.length)
    );
    expect(counts.size).toBe(1);
  });

  test('every observed lap is present — classify, never drop (RFC C7)', async () => {
    for (const file of Object.values(FILES)) {
      const sessions = await normalize(file);
      for (const s of sessions) {
        for (const lap of s.laps) {
          // Structural invariants for every lap, valid or not.
          expect(lap.sampleCount).toBeGreaterThan(0);
          expect(lap.lastSampleIndex).toBeGreaterThanOrEqual(lap.firstSampleIndex);
          if (!lap.completed) {
            // Incomplete laps carry an explanation.
            expect(lap.flags.length).toBeGreaterThan(0);
          }
          if (lap.completed) {
            expect(lap.lapTimeSec).not.toBeNull();
            expect(lap.timingSource).toBe('lap-last-lap-time');
          }
        }
      }
    }
  });
});
