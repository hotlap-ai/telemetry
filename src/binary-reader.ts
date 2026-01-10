import type { VarType } from './constants';
import { VAR_TYPE_SIZES } from './constants';
import type { Header, VarBuffer, VarHeader, DiskSubHeader } from './types';

const textDecoder = new TextDecoder();

export function readInt32LE(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

export function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export function readFloat32LE(view: DataView, offset: number): number {
  return view.getFloat32(offset, true);
}

export function readFloat64LE(view: DataView, offset: number): number {
  return view.getFloat64(offset, true);
}

export function readBigUint64LE(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

export function readBoolLE(view: DataView, offset: number): boolean {
  return view.getUint8(offset) !== 0;
}

export function readCharLE(view: DataView, offset: number): number {
  return view.getInt8(offset);
}

export function readString(buffer: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const maxEnd = offset + length;
  while (end < maxEnd && buffer[end] !== 0) end++;
  return textDecoder.decode(buffer.subarray(offset, end));
}

export function readVarValue(
  view: DataView,
  offset: number,
  type: VarType,
  count: number
): number | number[] | boolean | boolean[] {
  const size = VAR_TYPE_SIZES[type];

  if (count === 1) {
    switch (type) {
      case 0: return readCharLE(view, offset);
      case 1: return readBoolLE(view, offset);
      case 2: return readInt32LE(view, offset);
      case 3: return readUint32LE(view, offset);
      case 4: return readFloat32LE(view, offset);
      case 5: return readFloat64LE(view, offset);
    }
  }

  if (type === 1) {
    const result = new Array<boolean>(count);
    for (let i = 0; i < count; i++) {
      result[i] = readBoolLE(view, offset + i);
    }
    return result;
  }

  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const pos = offset + i * size;
    switch (type) {
      case 0: result[i] = readCharLE(view, pos); break;
      case 2: result[i] = readInt32LE(view, pos); break;
      case 3: result[i] = readUint32LE(view, pos); break;
      case 4: result[i] = readFloat32LE(view, pos); break;
      case 5: result[i] = readFloat64LE(view, pos); break;
    }
  }
  return result;
}

export function readVarValueBatch<T extends Float32Array | Float64Array | Int32Array | Uint32Array>(
  view: DataView,
  baseOffset: number,
  varOffset: number,
  type: VarType,
  bufLen: number,
  recordCount: number,
  output: T
): void {
  const size = VAR_TYPE_SIZES[type];
  let writeIdx = 0;

  switch (type) {
    case 4:
      for (let i = 0; i < recordCount; i++) {
        output[writeIdx++] = view.getFloat32(baseOffset + i * bufLen + varOffset, true);
      }
      break;
    case 5:
      for (let i = 0; i < recordCount; i++) {
        (output as Float64Array)[writeIdx++] = view.getFloat64(baseOffset + i * bufLen + varOffset, true);
      }
      break;
    case 2:
      for (let i = 0; i < recordCount; i++) {
        (output as Int32Array)[writeIdx++] = view.getInt32(baseOffset + i * bufLen + varOffset, true);
      }
      break;
    case 3:
      for (let i = 0; i < recordCount; i++) {
        (output as Uint32Array)[writeIdx++] = view.getUint32(baseOffset + i * bufLen + varOffset, true);
      }
      break;
  }
}

export function parseHeader(view: DataView): Header {
  const version = readInt32LE(view, 0);
  const status = readInt32LE(view, 4);
  const tickRate = readInt32LE(view, 8);
  const sessionInfoUpdate = readInt32LE(view, 12);
  const sessionInfoLen = readInt32LE(view, 16);
  const sessionInfoOffset = readInt32LE(view, 20);
  const numVars = readInt32LE(view, 24);
  const varHeaderOffset = readInt32LE(view, 28);
  const numBuf = readInt32LE(view, 32);
  const bufLen = readInt32LE(view, 36);

  const varBuf: VarBuffer[] = new Array(numBuf);
  for (let i = 0; i < numBuf; i++) {
    const offset = 48 + i * 16;
    varBuf[i] = {
      tickCount: readInt32LE(view, offset),
      bufOffset: readInt32LE(view, offset + 4),
    };
  }

  return {
    version,
    status,
    tickRate,
    sessionInfoUpdate,
    sessionInfoLen,
    sessionInfoOffset,
    numVars,
    varHeaderOffset,
    numBuf,
    bufLen,
    varBuf,
  };
}

export function parseVarHeader(view: DataView, buffer: Uint8Array, offset: number): VarHeader {
  return {
    type: readInt32LE(view, offset) as VarType,
    offset: readInt32LE(view, offset + 4),
    count: readInt32LE(view, offset + 8),
    countAsTime: readBoolLE(view, offset + 12),
    name: readString(buffer, offset + 16, 32),
    desc: readString(buffer, offset + 48, 64),
    unit: readString(buffer, offset + 112, 32),
  };
}

export function parseDiskSubHeader(view: DataView, offset: number): DiskSubHeader {
  return {
    sessionStartDate: readBigUint64LE(view, offset),
    sessionStartTime: readFloat64LE(view, offset + 8),
    sessionEndTime: readFloat64LE(view, offset + 16),
    sessionLapCount: readInt32LE(view, offset + 24),
    sessionRecordCount: readInt32LE(view, offset + 28),
  };
}

export function parseVarHeaders(view: DataView, buffer: Uint8Array, header: Header): Map<string, VarHeader> {
  const headers = new Map<string, VarHeader>();
  for (let i = 0; i < header.numVars; i++) {
    const varHeader = parseVarHeader(view, buffer, header.varHeaderOffset + i * 144);
    headers.set(varHeader.name, varHeader);
  }
  return headers;
}

export function getLatestVarBuffer(varBufs: VarBuffer[]): VarBuffer {
  if (varBufs.length === 0) {
    throw new Error('varBufs array is empty');
  }

  let latest = varBufs[0]!;
  let secondLatest = varBufs[1] ?? varBufs[0]!;

  for (let i = 1; i < varBufs.length; i++) {
    const current = varBufs[i]!;
    if (current.tickCount > latest.tickCount) {
      secondLatest = latest;
      latest = current;
    } else if (current.tickCount > secondLatest.tickCount) {
      secondLatest = current;
    }
  }

  return secondLatest;
}
