import { describe, it, expect, beforeEach } from 'bun:test';
import { IBT, parseIbtBuffer } from '../src/ibt';
import { DISK_SUB_HEADER_OFFSET } from '../src/constants';

function createMockIbtBuffer(): Uint8Array {
  const headerSize = 112;
  const diskSubHeaderSize = 32;
  const sessionInfoSize = 256;
  const varHeaderSize = 144;
  const numVars = 3;
  const varDataSize = 16;
  const numRecords = 5;
  const bufLen = varDataSize;

  const totalSize = headerSize + diskSubHeaderSize + sessionInfoSize +
    (varHeaderSize * numVars) + (bufLen * numRecords);

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);

  const varHeaderOffset = headerSize + diskSubHeaderSize + sessionInfoSize;
  const varBufOffset = varHeaderOffset + (varHeaderSize * numVars);

  // Header (112 bytes)
  view.setInt32(0, 2, true);                          // version
  view.setInt32(4, 1, true);                          // status (connected)
  view.setInt32(8, 60, true);                         // tickRate
  view.setInt32(12, 1, true);                         // sessionInfoUpdate
  view.setInt32(16, sessionInfoSize, true);           // sessionInfoLen
  view.setInt32(20, headerSize + diskSubHeaderSize, true); // sessionInfoOffset
  view.setInt32(24, numVars, true);                   // numVars
  view.setInt32(28, varHeaderOffset, true);           // varHeaderOffset
  view.setInt32(32, 1, true);                         // numBuf
  view.setInt32(36, bufLen, true);                    // bufLen

  // VarBuffer entry
  view.setInt32(48, 100, true);                       // varBuf[0].tickCount
  view.setInt32(52, varBufOffset, true);              // varBuf[0].bufOffset

  // Disk sub header (at offset 112)
  view.setBigUint64(DISK_SUB_HEADER_OFFSET, 1704067200000n, true);  // sessionStartDate
  view.setFloat64(DISK_SUB_HEADER_OFFSET + 8, 0.0, true);          // sessionStartTime
  view.setFloat64(DISK_SUB_HEADER_OFFSET + 16, 300.0, true);       // sessionEndTime
  view.setInt32(DISK_SUB_HEADER_OFFSET + 24, 3, true);             // sessionLapCount
  view.setInt32(DISK_SUB_HEADER_OFFSET + 28, numRecords, true);    // sessionRecordCount

  // Session info (YAML string)
  const sessionYaml = `
WeekendInfo:
 TrackName: laguna_seca
 TrackID: 123
 TrackDisplayName: Laguna Seca

DriverInfo:
 DriverCarIdx: 0

`;
  const sessionInfoOffset = headerSize + diskSubHeaderSize;
  for (let i = 0; i < sessionYaml.length && i < sessionInfoSize; i++) {
    buffer[sessionInfoOffset + i] = sessionYaml.charCodeAt(i);
  }

  // Variable headers
  const vars = [
    { name: 'Speed', type: 4, offset: 0, unit: 'm/s', desc: 'Vehicle speed' },
    { name: 'RPM', type: 4, offset: 4, unit: 'rev/min', desc: 'Engine RPM' },
    { name: 'Gear', type: 2, offset: 8, unit: '', desc: 'Current gear' },
  ];

  for (let i = 0; i < vars.length; i++) {
    const varOffset = varHeaderOffset + (i * varHeaderSize);
    const v = vars[i]!;

    view.setInt32(varOffset, v.type, true);           // type
    view.setInt32(varOffset + 4, v.offset, true);     // offset
    view.setInt32(varOffset + 8, 1, true);            // count
    buffer[varOffset + 12] = 0;                        // countAsTime

    // name (32 bytes at offset 16)
    for (let j = 0; j < v.name.length; j++) {
      buffer[varOffset + 16 + j] = v.name.charCodeAt(j);
    }

    // desc (64 bytes at offset 48)
    for (let j = 0; j < v.desc.length; j++) {
      buffer[varOffset + 48 + j] = v.desc.charCodeAt(j);
    }

    // unit (32 bytes at offset 112)
    for (let j = 0; j < v.unit.length; j++) {
      buffer[varOffset + 112 + j] = v.unit.charCodeAt(j);
    }
  }

  // Variable data (5 records)
  for (let i = 0; i < numRecords; i++) {
    const recordOffset = varBufOffset + (i * bufLen);
    view.setFloat32(recordOffset, 50.0 + i * 10, true);     // Speed: 50, 60, 70, 80, 90
    view.setFloat32(recordOffset + 4, 5000 + i * 500, true); // RPM: 5000, 5500, 6000, 6500, 7000
    view.setInt32(recordOffset + 8, i + 1, true);           // Gear: 1, 2, 3, 4, 5
  }

  return buffer;
}

describe('IBT Class', () => {
  let mockBuffer: Uint8Array;

  beforeEach(() => {
    mockBuffer = createMockIbtBuffer();
  });

  describe('fromBuffer', () => {
    it('should create IBT instance from buffer', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt).toBeInstanceOf(IBT);
    });

    it('should parse header correctly', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.tickRate).toBe(60);
    });

    it('should parse disk header correctly', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.recordCount).toBe(5);
      expect(ibt.sessionLapCount).toBe(3);
    });

    it('should parse variable headers', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const names = ibt.varHeaderNames;
      expect(names).toContain('Speed');
      expect(names).toContain('RPM');
      expect(names).toContain('Gear');
    });
  });

  describe('get', () => {
    it('should read Speed values', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);

      const speed0 = ibt.get(0, 'Speed') as number;
      const speed1 = ibt.get(1, 'Speed') as number;
      const speed4 = ibt.get(4, 'Speed') as number;

      expect(speed0).toBeCloseTo(50.0, 1);
      expect(speed1).toBeCloseTo(60.0, 1);
      expect(speed4).toBeCloseTo(90.0, 1);
    });

    it('should read RPM values', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);

      const rpm0 = ibt.get(0, 'RPM') as number;
      const rpm2 = ibt.get(2, 'RPM') as number;

      expect(rpm0).toBeCloseTo(5000.0, 0);
      expect(rpm2).toBeCloseTo(6000.0, 0);
    });

    it('should read Gear values', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);

      expect(ibt.get(0, 'Gear')).toBe(1);
      expect(ibt.get(2, 'Gear')).toBe(3);
      expect(ibt.get(4, 'Gear')).toBe(5);
    });

    it('should return null for unknown variable', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.get(0, 'Unknown')).toBeNull();
    });

    it('should return null for out of bounds index', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.get(-1, 'Speed')).toBeNull();
      expect(ibt.get(100, 'Speed')).toBeNull();
    });
  });

  describe('getAll', () => {
    it('should return all Speed values', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const speeds = ibt.getAll('Speed') as number[];

      expect(speeds).toHaveLength(5);
      expect(speeds[0]).toBeCloseTo(50.0, 1);
      expect(speeds[4]).toBeCloseTo(90.0, 1);
    });

    it('should return all Gear values', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const gears = ibt.getAll('Gear') as number[];

      expect(gears).toHaveLength(5);
      expect(gears).toEqual([1, 2, 3, 4, 5]);
    });

    it('should return null for unknown variable', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.getAll('Unknown')).toBeNull();
    });
  });

  describe('getAllTyped', () => {
    it('should return Float32Array for Speed', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const speeds = ibt.getAllTyped('Speed');

      expect(speeds).toBeInstanceOf(Float32Array);
      expect(speeds).toHaveLength(5);
      expect(speeds![0]).toBeCloseTo(50.0, 1);
    });

    it('should return Int32Array for Gear', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const gears = ibt.getAllTyped('Gear');

      expect(gears).toBeInstanceOf(Int32Array);
      expect(gears).toHaveLength(5);
    });

    it('should return null for unknown variable', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.getAllTyped('Unknown')).toBeNull();
    });
  });

  describe('getAllMultiple', () => {
    it('should return multiple variables', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const results = ibt.getAllMultiple(['Speed', 'RPM', 'Gear']);

      expect(results.has('Speed')).toBe(true);
      expect(results.has('RPM')).toBe(true);
      expect(results.has('Gear')).toBe(true);
      expect(results.get('Speed')).toHaveLength(5);
    });

    it('should skip unknown variables', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const results = ibt.getAllMultiple(['Speed', 'Unknown']);

      expect(results.has('Speed')).toBe(true);
      expect(results.has('Unknown')).toBe(false);
    });
  });

  describe('iterate', () => {
    it('should iterate through all records', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const records: Map<string, unknown>[] = [];

      for (const record of ibt.iterate(['Speed', 'Gear'])) {
        records.push(record);
      }

      expect(records).toHaveLength(5);
      expect(records[0]!.get('Gear')).toBe(1);
      expect(records[4]!.get('Gear')).toBe(5);
    });
  });

  describe('getVarHeader', () => {
    it('should return variable header', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const header = ibt.getVarHeader('Speed');

      expect(header).toBeDefined();
      expect(header!.name).toBe('Speed');
      expect(header!.type).toBe(4);
      expect(header!.unit).toBe('m/s');
    });

    it('should return undefined for unknown variable', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.getVarHeader('Unknown')).toBeUndefined();
    });
  });

  describe('getSessionInfo', () => {
    it('should parse WeekendInfo section', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const weekendInfo = ibt.getSessionInfo<{ TrackName: string; TrackID: number }>('WeekendInfo');

      expect(weekendInfo).toBeDefined();
      expect(weekendInfo!.TrackName).toBe('laguna_seca');
      expect(weekendInfo!.TrackID).toBe(123);
    });

    it('should return null for missing section', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.getSessionInfo('NonExistent')).toBeNull();
    });

    it('should cache session info', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);

      const first = ibt.getSessionInfo('WeekendInfo');
      const second = ibt.getSessionInfo('WeekendInfo');

      expect(first).toBe(second);
    });
  });

  describe('getRawSessionInfo', () => {
    it('should return raw YAML string', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const raw = ibt.getRawSessionInfo();

      expect(raw).toContain('WeekendInfo');
      expect(raw).toContain('TrackName');
    });
  });

  describe('properties', () => {
    it('should return correct recordCount', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.recordCount).toBe(5);
    });

    it('should return correct sessionLapCount', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.sessionLapCount).toBe(3);
    });

    it('should return correct tickRate', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.tickRate).toBe(60);
    });

    it('should return correct bufLen', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      expect(ibt.bufLen).toBe(16);
    });

    it('should return varHeaderNames', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);
      const names = ibt.varHeaderNames;

      expect(names).toHaveLength(3);
      expect(names).toContain('Speed');
      expect(names).toContain('RPM');
      expect(names).toContain('Gear');
    });
  });

  describe('close', () => {
    it('should clear all data', async () => {
      const ibt = await IBT.fromBuffer(mockBuffer);

      expect(ibt.recordCount).toBe(5);

      ibt.close();

      expect(ibt.recordCount).toBe(0);
      expect(ibt.varHeaderNames).toBeNull();
      expect(ibt.get(0, 'Speed')).toBeNull();
    });
  });
});

describe('parseIbtBuffer', () => {
  it('should create IBT from buffer', async () => {
    const mockBuffer = createMockIbtBuffer();
    const ibt = await parseIbtBuffer(mockBuffer);

    expect(ibt).toBeInstanceOf(IBT);
    expect(ibt.recordCount).toBe(5);
  });
});
