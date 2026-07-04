import { parse as parseYaml } from 'yaml';
import type { Header, VarHeader, DiskSubHeader, TelemetryValue, SessionInfo } from './types';
import type { VarType } from './constants';
import { VAR_TYPE_SIZES, DISK_SUB_HEADER_OFFSET } from './constants';
import {
  parseHeader,
  parseVarHeaders,
  parseDiskSubHeader,
  readVarValue,
  readVarValueBatch,
  readString,
} from './binary-reader';
// Canonical YAML cleaning lives in session-yaml.ts (RFC-0001 C5) — one copy.
import { cleanYamlFast } from './session-yaml';

export interface IbtOptions {
  lazyLoad?: boolean;
  preloadVars?: string[];
}

export class IBT {
  private buffer: Uint8Array | null = null;
  private view: DataView | null = null;
  private header: Header | null = null;
  private diskHeader: DiskSubHeader | null = null;
  private varHeaders: Map<string, VarHeader> | null = null;
  private sessionInfoCache: Map<string, unknown> = new Map();
  private static readonly sessionRegexCache = new Map<string, RegExp>();
  private rawSessionInfo: string | null = null;
  private filePath: string | null = null;

  private static getSectionRegex(key: string): RegExp {
    let regex = IBT.sessionRegexCache.get(key);
    if (!regex) {
      regex = new RegExp(`\n${key}:\n([\\s\\S]*?)(?=\n\n|$)`);
      IBT.sessionRegexCache.set(key, regex);
    }
    return regex;
  }

  get fileName(): string | null {
    return this.filePath;
  }

  get varHeaderBufferTick(): number | null {
    return this.header?.varBuf[0]?.tickCount ?? null;
  }

  get varHeaderNames(): string[] | null {
    if (!this.varHeaders) return null;
    return Array.from(this.varHeaders.keys());
  }

  get recordCount(): number {
    return this.diskHeader?.sessionRecordCount ?? 0;
  }

  get sessionLapCount(): number {
    return this.diskHeader?.sessionLapCount ?? 0;
  }

  get sessionStartTime(): number {
    return this.diskHeader?.sessionStartTime ?? 0;
  }

  get sessionEndTime(): number {
    return this.diskHeader?.sessionEndTime ?? 0;
  }

  get tickRate(): number {
    return this.header?.tickRate ?? 60;
  }

  get bufLen(): number {
    return this.header?.bufLen ?? 0;
  }

  async open(filePath: string): Promise<void> {
    this.filePath = filePath;
    const file = Bun.file(filePath);
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
    this.header = parseHeader(this.view);
    this.diskHeader = parseDiskSubHeader(this.view, DISK_SUB_HEADER_OFFSET);
    this.varHeaders = parseVarHeaders(this.view, this.buffer, this.header);
    this.sessionInfoCache.clear();
    this.rawSessionInfo = null;
  }

  openSync(filePath: string): void {
    this.filePath = filePath;
    const file = Bun.file(filePath);
    const arrayBuffer = file.arrayBuffer() as unknown as ArrayBuffer;
    if (arrayBuffer instanceof Promise) {
      throw new Error('Sync file reading requires Bun.file().bytes() - use open() instead');
    }
    this.buffer = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
    this.header = parseHeader(this.view);
    this.diskHeader = parseDiskSubHeader(this.view, DISK_SUB_HEADER_OFFSET);
    this.varHeaders = parseVarHeaders(this.view, this.buffer, this.header);
    this.sessionInfoCache.clear();
    this.rawSessionInfo = null;
  }

  static async fromBuffer(buffer: ArrayBuffer | Uint8Array): Promise<IBT> {
    const ibt = new IBT();
    ibt.buffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    ibt.view = new DataView(ibt.buffer.buffer, ibt.buffer.byteOffset, ibt.buffer.byteLength);
    ibt.header = parseHeader(ibt.view);
    ibt.diskHeader = parseDiskSubHeader(ibt.view, DISK_SUB_HEADER_OFFSET);
    ibt.varHeaders = parseVarHeaders(ibt.view, ibt.buffer, ibt.header);
    return ibt;
  }

  close(): void {
    this.buffer = null;
    this.view = null;
    this.header = null;
    this.diskHeader = null;
    this.varHeaders = null;
    this.sessionInfoCache.clear();
    this.rawSessionInfo = null;
    this.filePath = null;
  }

  getVarHeader(name: string): VarHeader | undefined {
    return this.varHeaders?.get(name);
  }

  get(index: number, key: string): TelemetryValue | null {
    if (!this.header || !this.view || !this.varHeaders || !this.diskHeader) return null;
    if (index < 0 || index >= this.diskHeader.sessionRecordCount) return null;

    const varHeader = this.varHeaders.get(key);
    if (!varHeader) return null;

    const varBuf = this.header.varBuf[0];
    if (!varBuf) return null;
    const varOffset = varHeader.offset + varBuf.bufOffset + index * this.header.bufLen;
    return readVarValue(this.view, varOffset, varHeader.type, varHeader.count);
  }

  getAll(key: string): TelemetryValue[] | null {
    if (!this.header || !this.view || !this.varHeaders || !this.diskHeader) return null;

    const varHeader = this.varHeaders.get(key);
    if (!varHeader) return null;

    const varBuf = this.header.varBuf[0];
    if (!varBuf) return null;
    const baseOffset = varBuf.bufOffset;
    const bufLen = this.header.bufLen;
    const recordCount = this.diskHeader.sessionRecordCount;
    const varOffset = varHeader.offset;
    const isArray = varHeader.count > 1;
    const results: TelemetryValue[] = new Array(recordCount);

    for (let i = 0; i < recordCount; i++) {
      const offset = baseOffset + i * bufLen + varOffset;
      results[i] = readVarValue(this.view, offset, varHeader.type, varHeader.count);
    }

    return results;
  }

  getAllTyped(key: string): Float32Array | Float64Array | Int32Array | Uint32Array | null {
    if (!this.header || !this.view || !this.varHeaders || !this.diskHeader) return null;

    const varHeader = this.varHeaders.get(key);
    if (!varHeader || varHeader.count !== 1) return null;

    const varBuf = this.header.varBuf[0];
    if (!varBuf) return null;
    const baseOffset = varBuf.bufOffset;
    const bufLen = this.header.bufLen;
    const recordCount = this.diskHeader.sessionRecordCount;
    const varOffset = varHeader.offset;

    let output: Float32Array | Float64Array | Int32Array | Uint32Array;
    switch (varHeader.type) {
      case 4:
        output = new Float32Array(recordCount);
        break;
      case 5:
        output = new Float64Array(recordCount);
        break;
      case 2:
        output = new Int32Array(recordCount);
        break;
      case 3:
        output = new Uint32Array(recordCount);
        break;
      default:
        return null;
    }

    readVarValueBatch(this.view, baseOffset, varOffset, varHeader.type, bufLen, recordCount, output);
    return output;
  }

  getAllMultiple(keys: string[]): Map<string, TelemetryValue[]> {
    const results = new Map<string, TelemetryValue[]>();
    if (!this.header || !this.view || !this.varHeaders || !this.diskHeader) return results;

    const varBuf = this.header.varBuf[0];
    if (!varBuf) return results;
    const baseOffset = varBuf.bufOffset;
    const bufLen = this.header.bufLen;
    const recordCount = this.diskHeader.sessionRecordCount;

    const varInfos: Array<{ key: string; varHeader: VarHeader; data: TelemetryValue[] }> = [];

    for (const key of keys) {
      const varHeader = this.varHeaders.get(key);
      if (varHeader) {
        const data: TelemetryValue[] = new Array(recordCount);
        varInfos.push({ key, varHeader, data });
        results.set(key, data);
      }
    }

    for (let i = 0; i < recordCount; i++) {
      const recordOffset = baseOffset + i * bufLen;
      for (const { varHeader, data } of varInfos) {
        const offset = recordOffset + varHeader.offset;
        data[i] = readVarValue(this.view, offset, varHeader.type, varHeader.count);
      }
    }

    return results;
  }

  *iterate(keys: string[]): Generator<Map<string, TelemetryValue>, void, unknown> {
    if (!this.header || !this.view || !this.varHeaders || !this.diskHeader) return;

    const varBuf = this.header.varBuf[0];
    if (!varBuf) return;
    const baseOffset = varBuf.bufOffset;
    const bufLen = this.header.bufLen;
    const recordCount = this.diskHeader.sessionRecordCount;

    const varInfos: Array<{ key: string; varHeader: VarHeader }> = [];
    for (const key of keys) {
      const varHeader = this.varHeaders.get(key);
      if (varHeader) {
        varInfos.push({ key, varHeader });
      }
    }

    for (let i = 0; i < recordCount; i++) {
      const recordOffset = baseOffset + i * bufLen;
      const record = new Map<string, TelemetryValue>();

      for (const { key, varHeader } of varInfos) {
        const offset = recordOffset + varHeader.offset;
        record.set(key, readVarValue(this.view, offset, varHeader.type, varHeader.count));
      }

      yield record;
    }
  }

  getRawSessionInfo(): string | null {
    if (!this.header || !this.buffer) return null;

    if (this.rawSessionInfo === null) {
      const start = this.header.sessionInfoOffset;
      const len = this.header.sessionInfoLen;
      this.rawSessionInfo = readString(this.buffer, start, len);
    }

    return this.rawSessionInfo;
  }

  getSessionInfo<T = unknown>(key?: string): T | null {
    const raw = this.getRawSessionInfo();
    if (!raw) return null;

    if (!key) {
      if (!this.sessionInfoCache.has('__full__')) {
        try {
          const cleaned = cleanYamlFast(raw);
          this.sessionInfoCache.set('__full__', parseYaml(cleaned));
        } catch {
          return null;
        }
      }
      return this.sessionInfoCache.get('__full__') as T;
    }

    if (this.sessionInfoCache.has(key)) {
      return this.sessionInfoCache.get(key) as T;
    }

    const sectionMatch = raw.match(IBT.getSectionRegex(key));
    if (!sectionMatch) return null;

    try {
      const sectionYaml = `${key}:\n${sectionMatch[1]}`;
      const cleaned = cleanYamlFast(sectionYaml);
      const parsed = parseYaml(cleaned);
      const result = parsed?.[key] ?? null;
      this.sessionInfoCache.set(key, result);
      return result as T;
    } catch {
      return null;
    }
  }
}

export async function parseIbt(filePath: string): Promise<IBT> {
  const ibt = new IBT();
  await ibt.open(filePath);
  return ibt;
}

export async function parseIbtBuffer(buffer: ArrayBuffer | Uint8Array): Promise<IBT> {
  return IBT.fromBuffer(buffer);
}
