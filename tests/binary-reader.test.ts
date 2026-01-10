import { describe, it, expect } from 'bun:test';
import {
  readInt32LE,
  readUint32LE,
  readFloat32LE,
  readFloat64LE,
  readBigUint64LE,
  readBoolLE,
  readCharLE,
  readString,
  readVarValue,
  readVarValueBatch,
  parseHeader,
  parseVarHeader,
  parseDiskSubHeader,
  getLatestVarBuffer,
} from '../src/binary-reader';
import type { VarBuffer } from '../src/types';

function createBuffer(size: number): { buffer: Uint8Array; view: DataView } {
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);
  return { buffer, view };
}

describe('Binary Reader - Primitive Types', () => {
  describe('readInt32LE', () => {
    it('should read positive integers', () => {
      const { view } = createBuffer(4);
      view.setInt32(0, 12345, true);
      expect(readInt32LE(view, 0)).toBe(12345);
    });

    it('should read negative integers', () => {
      const { view } = createBuffer(4);
      view.setInt32(0, -12345, true);
      expect(readInt32LE(view, 0)).toBe(-12345);
    });

    it('should read zero', () => {
      const { view } = createBuffer(4);
      view.setInt32(0, 0, true);
      expect(readInt32LE(view, 0)).toBe(0);
    });

    it('should read max int32', () => {
      const { view } = createBuffer(4);
      view.setInt32(0, 2147483647, true);
      expect(readInt32LE(view, 0)).toBe(2147483647);
    });

    it('should read min int32', () => {
      const { view } = createBuffer(4);
      view.setInt32(0, -2147483648, true);
      expect(readInt32LE(view, 0)).toBe(-2147483648);
    });
  });

  describe('readUint32LE', () => {
    it('should read unsigned integers', () => {
      const { view } = createBuffer(4);
      view.setUint32(0, 4294967295, true);
      expect(readUint32LE(view, 0)).toBe(4294967295);
    });

    it('should read zero', () => {
      const { view } = createBuffer(4);
      view.setUint32(0, 0, true);
      expect(readUint32LE(view, 0)).toBe(0);
    });
  });

  describe('readFloat32LE', () => {
    it('should read positive floats', () => {
      const { view } = createBuffer(4);
      view.setFloat32(0, 123.456, true);
      expect(readFloat32LE(view, 0)).toBeCloseTo(123.456, 2);
    });

    it('should read negative floats', () => {
      const { view } = createBuffer(4);
      view.setFloat32(0, -123.456, true);
      expect(readFloat32LE(view, 0)).toBeCloseTo(-123.456, 2);
    });

    it('should read zero', () => {
      const { view } = createBuffer(4);
      view.setFloat32(0, 0, true);
      expect(readFloat32LE(view, 0)).toBe(0);
    });
  });

  describe('readFloat64LE', () => {
    it('should read double precision floats', () => {
      const { view } = createBuffer(8);
      view.setFloat64(0, 123.456789012345, true);
      expect(readFloat64LE(view, 0)).toBeCloseTo(123.456789012345, 10);
    });

    it('should read very small numbers', () => {
      const { view } = createBuffer(8);
      view.setFloat64(0, 0.000000001, true);
      expect(readFloat64LE(view, 0)).toBeCloseTo(0.000000001, 15);
    });
  });

  describe('readBigUint64LE', () => {
    it('should read 64-bit unsigned integers', () => {
      const { view } = createBuffer(8);
      view.setBigUint64(0, 9007199254740991n, true);
      expect(readBigUint64LE(view, 0)).toBe(9007199254740991n);
    });

    it('should read zero', () => {
      const { view } = createBuffer(8);
      view.setBigUint64(0, 0n, true);
      expect(readBigUint64LE(view, 0)).toBe(0n);
    });
  });

  describe('readBoolLE', () => {
    it('should read true (non-zero)', () => {
      const { buffer, view } = createBuffer(1);
      buffer[0] = 1;
      expect(readBoolLE(view, 0)).toBe(true);
    });

    it('should read true (any non-zero value)', () => {
      const { buffer, view } = createBuffer(1);
      buffer[0] = 255;
      expect(readBoolLE(view, 0)).toBe(true);
    });

    it('should read false (zero)', () => {
      const { buffer, view } = createBuffer(1);
      buffer[0] = 0;
      expect(readBoolLE(view, 0)).toBe(false);
    });
  });

  describe('readCharLE', () => {
    it('should read positive char values', () => {
      const { view } = createBuffer(1);
      view.setInt8(0, 65);
      expect(readCharLE(view, 0)).toBe(65);
    });

    it('should read negative char values', () => {
      const { view } = createBuffer(1);
      view.setInt8(0, -1);
      expect(readCharLE(view, 0)).toBe(-1);
    });
  });
});

describe('Binary Reader - String Reading', () => {
  describe('readString', () => {
    it('should read null-terminated string', () => {
      const { buffer } = createBuffer(10);
      const str = 'Hello';
      for (let i = 0; i < str.length; i++) {
        buffer[i] = str.charCodeAt(i);
      }
      buffer[str.length] = 0;
      expect(readString(buffer, 0, 10)).toBe('Hello');
    });

    it('should read string up to length if no null terminator', () => {
      const { buffer } = createBuffer(5);
      const str = 'Hello';
      for (let i = 0; i < str.length; i++) {
        buffer[i] = str.charCodeAt(i);
      }
      expect(readString(buffer, 0, 5)).toBe('Hello');
    });

    it('should return empty string for empty buffer', () => {
      const { buffer } = createBuffer(1);
      buffer[0] = 0;
      expect(readString(buffer, 0, 1)).toBe('');
    });

    it('should read string from offset', () => {
      const { buffer } = createBuffer(10);
      buffer[0] = 65; // A
      buffer[1] = 66; // B
      buffer[2] = 67; // C - start here
      buffer[3] = 68; // D
      buffer[4] = 0;  // null terminator
      expect(readString(buffer, 2, 5)).toBe('CD');
    });
  });
});

describe('Binary Reader - Variable Value Reading', () => {
  describe('readVarValue', () => {
    it('should read single char (type 0)', () => {
      const { view } = createBuffer(1);
      view.setInt8(0, 42);
      expect(readVarValue(view, 0, 0, 1)).toBe(42);
    });

    it('should read single bool (type 1)', () => {
      const { buffer, view } = createBuffer(1);
      buffer[0] = 1;
      expect(readVarValue(view, 0, 1, 1)).toBe(true);
    });

    it('should read single int32 (type 2)', () => {
      const { view } = createBuffer(4);
      view.setInt32(0, 12345, true);
      expect(readVarValue(view, 0, 2, 1)).toBe(12345);
    });

    it('should read single uint32 (type 3)', () => {
      const { view } = createBuffer(4);
      view.setUint32(0, 4000000000, true);
      expect(readVarValue(view, 0, 3, 1)).toBe(4000000000);
    });

    it('should read single float32 (type 4)', () => {
      const { view } = createBuffer(4);
      view.setFloat32(0, 123.5, true);
      expect(readVarValue(view, 0, 4, 1)).toBeCloseTo(123.5, 1);
    });

    it('should read single float64 (type 5)', () => {
      const { view } = createBuffer(8);
      view.setFloat64(0, 123.456789, true);
      expect(readVarValue(view, 0, 5, 1)).toBeCloseTo(123.456789, 5);
    });

    it('should read array of bools', () => {
      const { buffer, view } = createBuffer(3);
      buffer[0] = 1;
      buffer[1] = 0;
      buffer[2] = 1;
      const result = readVarValue(view, 0, 1, 3);
      expect(result).toEqual([true, false, true]);
    });

    it('should read array of int32', () => {
      const { view } = createBuffer(12);
      view.setInt32(0, 100, true);
      view.setInt32(4, 200, true);
      view.setInt32(8, 300, true);
      const result = readVarValue(view, 0, 2, 3);
      expect(result).toEqual([100, 200, 300]);
    });

    it('should read array of float32', () => {
      const { view } = createBuffer(12);
      view.setFloat32(0, 1.5, true);
      view.setFloat32(4, 2.5, true);
      view.setFloat32(8, 3.5, true);
      const result = readVarValue(view, 0, 4, 3) as number[];
      expect(result[0]).toBeCloseTo(1.5, 1);
      expect(result[1]).toBeCloseTo(2.5, 1);
      expect(result[2]).toBeCloseTo(3.5, 1);
    });
  });

  describe('readVarValueBatch', () => {
    it('should read batch of float32 values', () => {
      const bufLen = 16;
      const recordCount = 3;
      const { view } = createBuffer(bufLen * recordCount);

      view.setFloat32(0, 1.0, true);
      view.setFloat32(bufLen, 2.0, true);
      view.setFloat32(bufLen * 2, 3.0, true);

      const output = new Float32Array(recordCount);
      readVarValueBatch(view, 0, 0, 4, bufLen, recordCount, output);

      expect(output[0]).toBeCloseTo(1.0, 1);
      expect(output[1]).toBeCloseTo(2.0, 1);
      expect(output[2]).toBeCloseTo(3.0, 1);
    });

    it('should read batch of int32 values', () => {
      const bufLen = 16;
      const recordCount = 3;
      const { view } = createBuffer(bufLen * recordCount);

      view.setInt32(4, 100, true);
      view.setInt32(bufLen + 4, 200, true);
      view.setInt32(bufLen * 2 + 4, 300, true);

      const output = new Int32Array(recordCount);
      readVarValueBatch(view, 0, 4, 2, bufLen, recordCount, output);

      expect(output[0]).toBe(100);
      expect(output[1]).toBe(200);
      expect(output[2]).toBe(300);
    });
  });
});

describe('Binary Reader - Header Parsing', () => {
  describe('parseHeader', () => {
    it('should parse header correctly', () => {
      const { view } = createBuffer(112);

      view.setInt32(0, 2, true);      // version
      view.setInt32(4, 1, true);      // status
      view.setInt32(8, 60, true);     // tickRate
      view.setInt32(12, 5, true);     // sessionInfoUpdate
      view.setInt32(16, 1000, true);  // sessionInfoLen
      view.setInt32(20, 112, true);   // sessionInfoOffset
      view.setInt32(24, 10, true);    // numVars
      view.setInt32(28, 1112, true);  // varHeaderOffset
      view.setInt32(32, 3, true);     // numBuf
      view.setInt32(36, 256, true);   // bufLen

      // varBuf entries
      view.setInt32(48, 100, true);   // varBuf[0].tickCount
      view.setInt32(52, 5000, true);  // varBuf[0].bufOffset
      view.setInt32(64, 200, true);   // varBuf[1].tickCount
      view.setInt32(68, 5256, true);  // varBuf[1].bufOffset
      view.setInt32(80, 150, true);   // varBuf[2].tickCount
      view.setInt32(84, 5512, true);  // varBuf[2].bufOffset

      const header = parseHeader(view);

      expect(header.version).toBe(2);
      expect(header.status).toBe(1);
      expect(header.tickRate).toBe(60);
      expect(header.sessionInfoUpdate).toBe(5);
      expect(header.sessionInfoLen).toBe(1000);
      expect(header.sessionInfoOffset).toBe(112);
      expect(header.numVars).toBe(10);
      expect(header.varHeaderOffset).toBe(1112);
      expect(header.numBuf).toBe(3);
      expect(header.bufLen).toBe(256);
      expect(header.varBuf).toHaveLength(3);
      expect(header.varBuf[0]).toEqual({ tickCount: 100, bufOffset: 5000 });
      expect(header.varBuf[1]).toEqual({ tickCount: 200, bufOffset: 5256 });
      expect(header.varBuf[2]).toEqual({ tickCount: 150, bufOffset: 5512 });
    });
  });

  describe('parseVarHeader', () => {
    it('should parse variable header correctly', () => {
      const { buffer, view } = createBuffer(144);

      view.setInt32(0, 4, true);       // type (float32)
      view.setInt32(4, 100, true);     // offset
      view.setInt32(8, 1, true);       // count
      buffer[12] = 0;                   // countAsTime (false)

      const name = 'Speed';
      for (let i = 0; i < name.length; i++) {
        buffer[16 + i] = name.charCodeAt(i);
      }

      const desc = 'Vehicle speed';
      for (let i = 0; i < desc.length; i++) {
        buffer[48 + i] = desc.charCodeAt(i);
      }

      const unit = 'm/s';
      for (let i = 0; i < unit.length; i++) {
        buffer[112 + i] = unit.charCodeAt(i);
      }

      const varHeader = parseVarHeader(view, buffer, 0);

      expect(varHeader.type).toBe(4);
      expect(varHeader.offset).toBe(100);
      expect(varHeader.count).toBe(1);
      expect(varHeader.countAsTime).toBe(false);
      expect(varHeader.name).toBe('Speed');
      expect(varHeader.desc).toBe('Vehicle speed');
      expect(varHeader.unit).toBe('m/s');
    });
  });

  describe('parseDiskSubHeader', () => {
    it('should parse disk sub header correctly', () => {
      const { view } = createBuffer(32);

      view.setBigUint64(0, 1704067200000n, true);  // sessionStartDate
      view.setFloat64(8, 123.456, true);           // sessionStartTime
      view.setFloat64(16, 789.012, true);          // sessionEndTime
      view.setInt32(24, 10, true);                 // sessionLapCount
      view.setInt32(28, 36000, true);              // sessionRecordCount

      const diskHeader = parseDiskSubHeader(view, 0);

      expect(diskHeader.sessionStartDate).toBe(1704067200000n);
      expect(diskHeader.sessionStartTime).toBeCloseTo(123.456, 3);
      expect(diskHeader.sessionEndTime).toBeCloseTo(789.012, 3);
      expect(diskHeader.sessionLapCount).toBe(10);
      expect(diskHeader.sessionRecordCount).toBe(36000);
    });
  });
});

describe('Binary Reader - Utility Functions', () => {
  describe('getLatestVarBuffer', () => {
    it('should return second latest buffer', () => {
      const varBufs: VarBuffer[] = [
        { tickCount: 100, bufOffset: 1000 },
        { tickCount: 300, bufOffset: 2000 },
        { tickCount: 200, bufOffset: 3000 },
      ];

      const result = getLatestVarBuffer(varBufs);
      expect(result).toEqual({ tickCount: 200, bufOffset: 3000 });
    });

    it('should handle two buffers', () => {
      const varBufs: VarBuffer[] = [
        { tickCount: 100, bufOffset: 1000 },
        { tickCount: 200, bufOffset: 2000 },
      ];

      const result = getLatestVarBuffer(varBufs);
      expect(result).toEqual({ tickCount: 100, bufOffset: 1000 });
    });

    it('should handle single buffer', () => {
      const varBufs: VarBuffer[] = [
        { tickCount: 100, bufOffset: 1000 },
      ];

      const result = getLatestVarBuffer(varBufs);
      expect(result).toEqual({ tickCount: 100, bufOffset: 1000 });
    });

    it('should throw on empty array', () => {
      expect(() => getLatestVarBuffer([])).toThrow('varBufs array is empty');
    });
  });
});
