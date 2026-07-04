/**
 * Tests for the canonical session-YAML module (RFC-0001 C5).
 * Golden assertions use the same sample files as normalize.test.ts (skip
 * gracefully without fixtures); decode/parse behavior is covered by
 * synthetic cases that need no fixtures.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanYamlFast,
  decodeSessionYaml,
  parseSessionYaml,
  readSessionInfoRange,
  resolveSessionMetadata,
  sessionMetadataFromYamlBytes,
  sessionTypeForSessionNum,
  parseTrackLengthKm,
} from '../src/session-yaml';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures', 'files');
const SAMPLES_DIR =
  process.env.IBT_SAMPLES_DIR ??
  (existsSync(FIXTURES_DIR) ? FIXTURES_DIR
    : 'C:/Users/sergi/DEV/hotlap.ai/hotlap.ai/UI/public/telemetry');
const IMOLA = 'acuransxevo22gt3_imola gp 2025-12-22 23-27-46.ibt';
const VEE = 'formulavee_miami gp 2025-12-26 18-54-31.ibt';
const available = existsSync(join(SAMPLES_DIR, IMOLA));

describe('decodeSessionYaml', () => {
  test('plain UTF-8 passes through', () => {
    const bytes = new TextEncoder().encode('WeekendInfo:\n TrackName: okayama\n');
    expect(decodeSessionYaml(bytes)).toContain('okayama');
  });

  test('windows-1252 fallback on invalid UTF-8 (RFC D5)', () => {
    // 0xE9 = é in windows-1252; invalid as a standalone UTF-8 byte.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('UserName: Andr'),
      0xe9,
      ...new TextEncoder().encode('\n'),
    ]);
    const text = decodeSessionYaml(bytes);
    expect(text).toContain('André');
    expect(text).not.toContain('�');
  });

  test('trims at NUL padding', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('A: 1\n'), 0, 0x41, 0x41]);
    expect(decodeSessionYaml(bytes)).toBe('A: 1\n');
  });
});

describe('parseSessionYaml + resolveSessionMetadata (synthetic)', () => {
  const RAW = `
WeekendInfo:
 TrackName: virginia 2022 full
 TrackID: 431
 TrackDisplayName: Virginia International Raceway
 TrackConfigName: Full Course
 TrackLength: 5.22 km
 TrackNumTurns: 17
 SeriesID: 550
 SeasonID: 5555
 SessionID: 313404697
 SubSessionID: 86707072
 Official: 1
 EventType: Race
 Category: Road
DriverInfo:
 DriverCarIdx: 52
 Drivers:
 - CarIdx: 0
   UserName: Pace Car
   CarID: 11
 - CarIdx: 52
   UserName: Sergio Masellis
   UserID: 863752
   TeamName: ""
   CarNumber: "53"
   CarID: 173
   CarClassID: 2708
   CarScreenName: Ferrari 296 GT3
   CarPath: ferrari296gt3
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Practice
   SessionName: PRACTICE
 - SessionNum: 1
   SessionType: Lone Qualify
   SessionName: QUALIFY
 - SessionNum: 2
   SessionType: Race
   SessionName: RACE
`;

  test('resolves driver, car, track, and full session types', () => {
    const meta = resolveSessionMetadata(parseSessionYaml(RAW)!);
    expect(meta.driverName).toBe('Sergio Masellis');
    expect(meta.driverCarIdx).toBe(52);
    expect(meta.carId).toBe(173);
    expect(meta.carScreenName).toBe('Ferrari 296 GT3');
    expect(meta.carPath).toBe('ferrari296gt3');
    expect(meta.trackId).toBe(431);
    expect(meta.trackName).toBe('Virginia International Raceway');
    expect(meta.trackLengthKm).toBeCloseTo(5.22, 3);
    expect(meta.subSessionId).toBe(86707072);
    expect(meta.eventType).toBe('Race');
    expect(meta.official).toBe(true);
    // D4 fix: SessionNum-resolved, full strings, never first-occurrence.
    expect(sessionTypeForSessionNum(meta, 2)).toBe('Race');
    expect(sessionTypeForSessionNum(meta, 1)).toBe('Lone Qualify');
    expect(sessionTypeForSessionNum(meta, 0)).toBe('Practice');
  });

  test('cleanYamlFast escapes iRacing name fields', () => {
    const cleaned = cleanYamlFast('UserName: John "Rocket" O\'Neil\n');
    expect(parseSessionYaml(cleaned)).not.toBeNull();
  });

  test('parseTrackLengthKm handles both units and garbage', () => {
    expect(parseTrackLengthKm('5.22 km')).toBeCloseTo(5.22, 3);
    expect(parseTrackLengthKm('unknown')).toBeNull();
    expect(parseTrackLengthKm(undefined)).toBeNull();
    expect(parseTrackLengthKm(4.9)).toBeCloseTo(4.9, 3);
  });
});

describe.skipIf(!available)('golden samples', () => {
  async function metaFor(file: string) {
    const bytes = new Uint8Array(await Bun.file(join(SAMPLES_DIR, file)).arrayBuffer());
    const { sessionInfoOffset, sessionInfoLen } = readSessionInfoRange(
      bytes.subarray(0, 48)
    );
    // Simulate the Edge Functions' range-download pattern.
    const yamlBytes = bytes.subarray(sessionInfoOffset, sessionInfoOffset + sessionInfoLen);
    return sessionMetadataFromYamlBytes(yamlBytes)!;
  }

  test('Imola GT3: race weekend resolved via sessions list', async () => {
    const meta = await metaFor(IMOLA);
    expect(meta).not.toBeNull();
    expect(meta.carScreenName).toContain('Acura');
    expect(meta.eventType).toBe('Race');
    // SessionNum channel is 2 for this file (normalize.test.ts) → Race.
    expect(sessionTypeForSessionNum(meta, 2)).toBe('Race');
    expect(meta.trackLengthKm).toBeGreaterThan(4.8);
    expect(meta.trackLengthKm).toBeLessThan(5.0);
    expect(meta.sessions.length).toBeGreaterThanOrEqual(2);
  });

  test('Formula Vee: full "Offline Testing" string (D4 truncation fix)', async () => {
    const meta = await metaFor(VEE);
    expect(sessionTypeForSessionNum(meta, 0)).toBe('Offline Testing');
    expect(meta.eventType).toBe('Test');
  });
});
