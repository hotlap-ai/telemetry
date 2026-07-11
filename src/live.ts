import { parse as parseYaml } from 'yaml';
import type { Header, VarHeader, TelemetryValue } from './types';
import type { VarType } from './constants';
import {
  SIM_STATUS_URL,
  StatusField,
  BroadcastMsg,
  CameraState,
  ChatCommandMode,
  PitCommandMode,
  TelemCommandMode,
  RpyStateMode,
  ReloadTexturesMode,
  RpySrchMode,
  RpyPosMode,
  FFBCommandMode,
  VideoCaptureMode,
} from './constants';
import {
  parseHeader,
  parseVarHeaders,
  readVarValue,
  readString,
  getLatestVarBuffer,
} from './binary-reader';

let kernel32: ReturnType<typeof loadKernel32> | null = null;
let user32: ReturnType<typeof loadUser32> | null = null;

function loadKernel32() {
  const { dlopen, FFIType, suffix } = require('bun:ffi');
  return dlopen(`kernel32.${suffix}`, {
    OpenEventW: {
      args: [FFIType.u32, FFIType.bool, FFIType.ptr],
      returns: FFIType.ptr,
    },
    OpenFileMappingW: {
      args: [FFIType.u32, FFIType.bool, FFIType.ptr],
      returns: FFIType.ptr,
    },
    MapViewOfFile: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.ptr,
    },
    UnmapViewOfFile: {
      args: [FFIType.ptr],
      returns: FFIType.bool,
    },
    CloseHandle: {
      args: [FFIType.ptr],
      returns: FFIType.bool,
    },
    WaitForSingleObject: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
  });
}

function loadUser32() {
  const { dlopen, FFIType, suffix } = require('bun:ffi');
  return dlopen(`user32.${suffix}`, {
    RegisterWindowMessageW: {
      args: [FFIType.ptr],
      returns: FFIType.u32,
    },
    SendNotifyMessageW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.bool,
    },
  });
}

const FILE_MAP_READ = 0x0004;
const SYNCHRONIZE = 0x00100000;
const WAIT_OBJECT_0 = 0;
const HWND_BROADCAST = 0xFFFF;
const DATA_VALID_EVENT_NAME = 'Local\\IRSDKDataValidEvent';
const MEMMAPFILE = 'Local\\IRSDKMemMapFileName';
const MEMMAPFILESIZE = 1164 * 1024;
const BROADCASTMSGNAME = 'IRSDK_BROADCASTMSG';

function toWideString(str: string): Uint8Array {
  const buf = new Uint8Array((str.length + 1) * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[i * 2] = code & 0xFF;
    buf[i * 2 + 1] = (code >> 8) & 0xFF;
  }
  return buf;
}

function ensureFFILoaded(): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    if (!kernel32) kernel32 = loadKernel32();
    if (!user32) user32 = loadUser32();
    return true;
  } catch {
    return false;
  }
}

// Pre-compiled regexes for YAML cleaning (allocated once, reused forever)
const YAML_SPECIAL_FIELDS_REGEX = /((?:DriverSetupName|UserName|TeamName|AbbrevName|Initials): )(.*)/g;
const YAML_COMMA_VALUE_REGEX = /(\w+: )(,.*)/g;

/**
 * Fast single-pass YAML cleaning function.
 * Combines multiple string operations to reduce intermediate allocations.
 */
function cleanYamlFast(yaml: string): string {
  // Single-pass character cleaning using a more efficient approach
  let cleaned = '';
  for (let i = 0; i < yaml.length; i++) {
    const code = yaml.charCodeAt(i);
    // Skip problematic Windows-1252 characters and non-printable chars
    if (code === 0x81 || code === 0x8D || code === 0x8F || code === 0x90 || code === 0x9D) {
      cleaned += ' ';
    } else if (
      code === 0x09 || code === 0x0A || code === 0x0D || // Tab, LF, CR
      (code >= 0x20 && code <= 0x7E) || // Printable ASCII
      (code >= 0xA0 && code <= 0xFF)    // Extended ASCII
    ) {
      cleaned += yaml[i];
    }
    // Skip other non-printable characters
  }

  // Apply field-specific escaping
  cleaned = cleaned.replace(
    YAML_SPECIAL_FIELDS_REGEX,
    (_, prefix, value) => {
      const escaped = value.replace(/["\\]/g, '\\$&');
      return `${prefix}"${escaped}"`;
    }
  );

  // Handle comma-starting values
  cleaned = cleaned.replace(YAML_COMMA_VALUE_REGEX, '$1"$2"');

  return cleaned;
}

export interface IRSDKOptions {
  parseYamlAsync?: boolean;
}

export class IRSDK {
  private parseYamlAsync: boolean;
  private sharedMemPtr: unknown = null;
  private sharedMemBuffer: Uint8Array | null = null;
  private sharedMemView: DataView | null = null;
  private fileMappingHandle: unknown = null;
  private dataValidEvent: unknown = null;
  private header: Header | null = null;
  private varHeaders: Map<string, VarHeader> | null = null;
  private varHeadersNames: string[] | null = null;
  private sessionInfoCache: Map<string, { data: unknown; update: number }> = new Map();
  private static readonly sessionRegexCache = new Map<string, RegExp>();
  private broadcastMsgId: number | null = null;
  private lastSessionInfoUpdate = 0;
  private workaroundConnectedState = 0;
  private frozenBuffer: Uint8Array | null = null;
  private frozenView: DataView | null = null;
  private frozenBufOffset = 0;
  private frozenBufferCapacity = 0;
  private testMode = false;
  isInitialized = false;

  constructor(options: IRSDKOptions = {}) {
    this.parseYamlAsync = options.parseYamlAsync ?? false;
  }

  // The header parsed at startup is a SNAPSHOT. Fields iRacing keeps
  // updating (status, sessionInfoUpdate, session-info offset/length, var
  // buffer tick counts) must be re-read from shared memory on every access,
  // otherwise the reader is frozen in time: the session-info cache never
  // invalidates and rosters/results go permanently stale.
  private liveHeaderInt(byteOffset: number, fallback = 0): number {
    if (this.testMode) return fallback;
    return this.sharedMemView ? this.sharedMemView.getInt32(byteOffset, true) : fallback;
  }

  private get liveStatus(): number {
    return this.liveHeaderInt(4, this.header?.status ?? 0);
  }

  /** Tear-safe read target: the second-latest buffer by LIVE tick count. */
  private liveReadBufOffset(): number {
    const varBufs = this.header!.varBuf;
    if (this.testMode || !this.sharedMemView) {
      return getLatestVarBuffer(varBufs).bufOffset;
    }

    let latestTick = -1;
    let latestOffset = varBufs[0]!.bufOffset;
    let secondTick = -1;
    let secondOffset = varBufs[0]!.bufOffset;
    for (let i = 0; i < varBufs.length; i++) {
      const tick = this.liveHeaderInt(48 + i * 16);
      const offset = varBufs[i]!.bufOffset;
      if (tick > latestTick) {
        secondTick = latestTick;
        secondOffset = latestOffset;
        latestTick = tick;
        latestOffset = offset;
      } else if (tick > secondTick) {
        secondTick = tick;
        secondOffset = offset;
      }
    }
    return varBufs.length > 1 && secondTick >= 0 ? secondOffset : latestOffset;
  }

  /** Freeze target: the newest buffer by LIVE tick count. */
  private liveLatestBufOffset(): number {
    const varBufs = this.header!.varBuf;
    if (this.testMode || !this.sharedMemView) {
      return varBufs.reduce((a, b) => (a.tickCount > b.tickCount ? a : b)).bufOffset;
    }

    let latestTick = -1;
    let latestOffset = varBufs[0]!.bufOffset;
    for (let i = 0; i < varBufs.length; i++) {
      const tick = this.liveHeaderInt(48 + i * 16);
      if (tick > latestTick) {
        latestTick = tick;
        latestOffset = varBufs[i]!.bufOffset;
      }
    }
    return latestOffset;
  }

  get isConnected(): boolean {
    if (!this.header) return false;

    if (this.liveStatus === StatusField.STATUS_CONNECTED) {
      this.workaroundConnectedState = 0;
    }
    if (this.workaroundConnectedState === 0 && this.liveStatus !== StatusField.STATUS_CONNECTED) {
      this.workaroundConnectedState = 1;
    }
    if (this.workaroundConnectedState === 1 && this.get('SessionNum') === null) {
      this.workaroundConnectedState = 2;
    }
    if (this.workaroundConnectedState === 2 && this.get('SessionNum') !== null) {
      this.workaroundConnectedState = 3;
    }

    return (
      (this.dataValidEvent !== null || this.testMode) &&
      (this.liveStatus === StatusField.STATUS_CONNECTED || this.workaroundConnectedState === 3)
    );
  }

  get sessionInfoUpdate(): number {
    return this.liveHeaderInt(12, this.header?.sessionInfoUpdate ?? 0);
  }

  get varHeaderNames(): string[] | null {
    if (!this.varHeaders) return null;
    if (!this.varHeadersNames) {
      this.varHeadersNames = Array.from(this.varHeaders.keys());
    }
    return this.varHeadersNames;
  }

  async startup(testFile?: string, dumpTo?: string): Promise<boolean> {
    if (testFile) {
      return this.startupFromFile(testFile, dumpTo);
    }

    if (!ensureFFILoaded() || !kernel32) {
      console.error('FFI not available - live telemetry requires Windows');
      return false;
    }

    const simRunning = await this.checkSimStatus();
    if (!simRunning) return false;

    const { ptr, toArrayBuffer } = require('bun:ffi');

    const eventNameWide = toWideString(DATA_VALID_EVENT_NAME);
    this.dataValidEvent = kernel32.symbols.OpenEventW(SYNCHRONIZE, false, ptr(eventNameWide));

    if (!this.waitValidDataEvent()) {
      this.dataValidEvent = null;
      return false;
    }

    const fileNameWide = toWideString(MEMMAPFILE);
    this.fileMappingHandle = kernel32.symbols.OpenFileMappingW(
      FILE_MAP_READ,
      false,
      ptr(fileNameWide)
    );

    if (!this.fileMappingHandle) return false;

    this.sharedMemPtr = kernel32.symbols.MapViewOfFile(
      this.fileMappingHandle,
      FILE_MAP_READ,
      0,
      0,
      MEMMAPFILESIZE
    );

    if (!this.sharedMemPtr) {
      kernel32.symbols.CloseHandle(this.fileMappingHandle);
      this.fileMappingHandle = null;
      return false;
    }

    const arrayBuffer = toArrayBuffer(this.sharedMemPtr, 0, MEMMAPFILESIZE);
    this.sharedMemBuffer = new Uint8Array(arrayBuffer);
    this.sharedMemView = new DataView(arrayBuffer);

    if (this.sharedMemView) {
      if (dumpTo) {
        await Bun.write(dumpTo, this.sharedMemBuffer);
      }

      this.header = parseHeader(this.sharedMemView);
      this.isInitialized = this.header.version >= 1 && this.header.varBuf.length > 0;

      if (this.isInitialized) {
        this.varHeaders = parseVarHeaders(this.sharedMemView, this.sharedMemBuffer, this.header);
      }
    }

    return this.isInitialized;
  }

  private async startupFromFile(testFile: string, dumpTo?: string): Promise<boolean> {
    this.testMode = true;
    const file = Bun.file(testFile);
    const arrayBuffer = await file.arrayBuffer();
    this.sharedMemBuffer = new Uint8Array(arrayBuffer);
    this.sharedMemView = new DataView(arrayBuffer);

    if (dumpTo) {
      await Bun.write(dumpTo, this.sharedMemBuffer);
    }

    this.header = parseHeader(this.sharedMemView);
    this.isInitialized = this.header.version >= 1 && this.header.varBuf.length > 0;

    if (this.isInitialized) {
      this.varHeaders = parseVarHeaders(this.sharedMemView, this.sharedMemBuffer, this.header);
    }

    return this.isInitialized;
  }

  shutdown(): void {
    this.isInitialized = false;
    this.lastSessionInfoUpdate = 0;

    if (kernel32) {
      if (this.sharedMemPtr) {
        kernel32.symbols.UnmapViewOfFile(this.sharedMemPtr);
        this.sharedMemPtr = null;
      }

      if (this.fileMappingHandle) {
        kernel32.symbols.CloseHandle(this.fileMappingHandle);
        this.fileMappingHandle = null;
      }

      if (this.dataValidEvent) {
        kernel32.symbols.CloseHandle(this.dataValidEvent);
        this.dataValidEvent = null;
      }
    }

    this.sharedMemBuffer = null;
    this.sharedMemView = null;
    this.header = null;
    this.varHeaders = null;
    this.varHeadersNames = null;
    this.sessionInfoCache.clear();
    this.broadcastMsgId = null;
    this.frozenBuffer = null;
    this.frozenView = null;
    this.testMode = false;
  }

  get(key: string): TelemetryValue | null {
    if (!this.header || !this.varHeaders) return null;

    const varHeader = this.varHeaders.get(key);
    if (!varHeader) {
      return this.getSessionInfo(key);
    }

    const isFrozen = this.isFrozen;
    const view = isFrozen ? this.frozenView : this.sharedMemView;
    if (!view) return null;

    const bufOffset = isFrozen ? this.frozenBufOffset : this.liveReadBufOffset();
    return readVarValue(view, bufOffset + varHeader.offset, varHeader.type, varHeader.count);
  }

  /**
   * Batch read multiple telemetry variables in a single pass.
   * Much more efficient than calling get() multiple times.
   * @param keys Array of variable names to read
   * @returns Map of variable names to their values
   */
  getMultiple(keys: string[]): Map<string, TelemetryValue> {
    const results = new Map<string, TelemetryValue>();
    if (!this.header || !this.varHeaders) return results;

    const isFrozen = this.isFrozen;
    const view = isFrozen ? this.frozenView : this.sharedMemView;
    if (!view) return results;

    const bufOffset = isFrozen
      ? this.frozenBufOffset
      : this.liveReadBufOffset();

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const varHeader = this.varHeaders.get(key);
      if (varHeader) {
        results.set(key, readVarValue(view, bufOffset + varHeader.offset, varHeader.type, varHeader.count));
      }
    }

    return results;
  }

  /**
   * Batch read multiple telemetry variables into a pre-allocated object.
   * Zero allocation in the hot path - fastest option for real-time telemetry.
   * @param keys Array of variable names to read
   * @param out Pre-allocated object to write values into
   */
  getMultipleInto<T extends Record<string, TelemetryValue | null>>(keys: string[], out: T): T {
    if (!this.header || !this.varHeaders) {
      for (let i = 0; i < keys.length; i++) {
        (out as Record<string, TelemetryValue | null>)[keys[i]!] = null;
      }
      return out;
    }

    const isFrozen = this.isFrozen;
    const view = isFrozen ? this.frozenView : this.sharedMemView;
    if (!view) return out;

    const bufOffset = isFrozen
      ? this.frozenBufOffset
      : this.liveReadBufOffset();

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const varHeader = this.varHeaders.get(key);
      if (varHeader) {
        (out as Record<string, TelemetryValue | null>)[key] = readVarValue(view, bufOffset + varHeader.offset, varHeader.type, varHeader.count);
      } else {
        (out as Record<string, TelemetryValue | null>)[key] = null;
      }
    }

    return out;
  }

  /**
   * Creates a pre-compiled reader for maximum performance in hot loops.
   * Pre-computes all offsets at creation time, avoiding Map lookups during reads.
   * @param keys Array of variable names to read
   * @returns A reader object with a read() method that returns values as an array
   */
  createReader(keys: string[]): { read: () => (TelemetryValue | null)[], keys: string[] } {
    if (!this.header || !this.varHeaders) {
      return {
        read: () => keys.map(() => null),
        keys
      };
    }

    // Pre-compute all variable info at creation time
    const varInfos: Array<{ offset: number; type: number; count: number } | null> = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const varHeader = this.varHeaders.get(keys[i]!);
      if (varHeader) {
        varInfos[i] = { offset: varHeader.offset, type: varHeader.type, count: varHeader.count };
      } else {
        varInfos[i] = null;
      }
    }

    const self = this;
    const results: (TelemetryValue | null)[] = new Array(keys.length);

    return {
      keys,
      read(): (TelemetryValue | null)[] {
        if (!self.header) {
          for (let i = 0; i < keys.length; i++) results[i] = null;
          return results;
        }

        const isFrozen = self.isFrozen;
        const view = isFrozen ? self.frozenView : self.sharedMemView;
        if (!view) {
          for (let i = 0; i < keys.length; i++) results[i] = null;
          return results;
        }

        const bufOffset = isFrozen
          ? self.frozenBufOffset
          : self.liveReadBufOffset();

        for (let i = 0; i < varInfos.length; i++) {
          const info = varInfos[i];
          if (info) {
            results[i] = readVarValue(view, bufOffset + info.offset, info.type as VarType, info.count);
          } else {
            results[i] = null;
          }
        }

        return results;
      }
    };
  }

  freezeVarBufferLatest(): void {
    if (!this.header || !this.sharedMemBuffer) return;

    this.waitValidDataEvent();
    const latestBufOffset = this.liveLatestBufOffset();
    const bufLen = this.header.bufLen;

    // Pre-allocate or reuse frozen buffer to avoid allocations in hot path
    if (!this.frozenBuffer || this.frozenBufferCapacity < bufLen) {
      this.frozenBuffer = new Uint8Array(bufLen);
      this.frozenBufferCapacity = bufLen;
      this.frozenView = new DataView(this.frozenBuffer.buffer);
    }

    // Copy data into pre-allocated buffer (much faster than slice)
    this.frozenBuffer.set(
      new Uint8Array(this.sharedMemBuffer.buffer, latestBufOffset, bufLen)
    );
    this.frozenBufOffset = 0;
  }

  unfreezeVarBufferLatest(): void {
    // Don't null out frozenBuffer/frozenView - keep them for reuse
    // Just reset the offset to indicate we're not frozen
    this.frozenBufOffset = -1;
  }

  private get isFrozen(): boolean {
    return this.frozenBufOffset >= 0 && this.frozenView !== null;
  }

  private async checkSimStatus(): Promise<boolean> {
    try {
      const response = await fetch(SIM_STATUS_URL);
      const text = await response.text();
      return text.includes('running:1');
    } catch {
      return false;
    }
  }

  private waitValidDataEvent(): boolean {
    if (!kernel32) return true;
    if (this.dataValidEvent) {
      return kernel32.symbols.WaitForSingleObject(this.dataValidEvent, 32) === WAIT_OBJECT_0;
    }
    return true;
  }

  private static getSectionRegex(key: string): RegExp {
    let regex = IRSDK.sessionRegexCache.get(key);
    if (!regex) {
      regex = new RegExp(`\n${key}:\n([\\s\\S]*?)(?=\n\n|$)`);
      IRSDK.sessionRegexCache.set(key, regex);
    }
    return regex;
  }

  getSessionInfo<T = unknown>(key: string): T | null {
    if (!this.header || !this.sharedMemBuffer) return null;

    // Live counter — iRacing bumps it on roster/results/session changes.
    if (this.lastSessionInfoUpdate !== this.sessionInfoUpdate) {
      this.lastSessionInfoUpdate = this.sessionInfoUpdate;
      for (const [k, v] of this.sessionInfoCache) {
        if (v.data) {
          this.sessionInfoCache.set(k, { ...v, data: null });
        }
      }
    }

    const cached = this.sessionInfoCache.get(key);
    if (cached?.data) {
      return cached.data as T;
    }

    // Offset/length move as the YAML grows — read them live too.
    const start = this.liveHeaderInt(20, this.header.sessionInfoOffset);
    const len = this.liveHeaderInt(16, this.header.sessionInfoLen);
    const raw = readString(this.sharedMemBuffer, start, len);

    const sectionMatch = raw.match(IRSDK.getSectionRegex(key));
    if (!sectionMatch) return null;

    try {
      const sectionYaml = `${key}:\n${sectionMatch[1]}`;
      const cleaned = cleanYamlFast(sectionYaml);
      const parsed = parseYaml(cleaned);
      const result = parsed?.[key] ?? null;
      this.sessionInfoCache.set(key, { data: result, update: this.lastSessionInfoUpdate });
      return result as T;
    } catch {
      return null;
    }
  }

  private getBroadcastMsgId(): number {
    if (!user32) return 0;
    if (this.broadcastMsgId === null) {
      const { ptr } = require('bun:ffi');
      const msgNameWide = toWideString(BROADCASTMSGNAME);
      this.broadcastMsgId = user32.symbols.RegisterWindowMessageW(ptr(msgNameWide)) as number;
    }
    return this.broadcastMsgId;
  }

  private broadcastMsg(broadcastType: number, var1 = 0, var2 = 0, var3 = 0): boolean {
    if (!user32) return false;
    return user32.symbols.SendNotifyMessageW(
      HWND_BROADCAST,
      this.getBroadcastMsgId(),
      (broadcastType | (var1 << 16)) >>> 0,
      (var2 | (var3 << 16)) >>> 0
    ) as boolean;
  }

  private padCarNum(num: string | number): number {
    const numStr = String(num);
    const numLen = numStr.length;
    let zero = numLen - numStr.replace(/^0+/, '').length;
    if (zero > 0 && numLen === zero) zero--;

    const numVal = parseInt(numStr, 10);
    if (zero) {
      const numPlace = numVal > 99 ? 3 : numVal > 9 ? 2 : 1;
      return numVal + 1000 * (numPlace + zero);
    }
    return numVal;
  }

  camSwitchPos(position = 0, group = 1, camera = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.CAM_SWITCH_POS, position, group, camera);
  }

  camSwitchNum(carNumber: string | number = '1', group = 1, camera = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.CAM_SWITCH_NUM, this.padCarNum(carNumber), group, camera);
  }

  camSetState(cameraState = CameraState.CAM_TOOL_ACTIVE): boolean {
    return this.broadcastMsg(BroadcastMsg.CAM_SET_STATE, cameraState);
  }

  replaySetPlaySpeed(speed = 0, slowMotion = false): boolean {
    return this.broadcastMsg(BroadcastMsg.REPLAY_SET_PLAY_SPEED, speed, slowMotion ? 1 : 0);
  }

  replaySetPlayPosition(posMode = RpyPosMode.BEGIN, frameNum = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.REPLAY_SET_PLAY_POSITION, posMode, frameNum);
  }

  replaySearch(searchMode = RpySrchMode.TO_START): boolean {
    return this.broadcastMsg(BroadcastMsg.REPLAY_SEARCH, searchMode);
  }

  replaySetState(stateMode = RpyStateMode.ERASE_TAPE): boolean {
    return this.broadcastMsg(BroadcastMsg.REPLAY_SET_STATE, stateMode);
  }

  reloadAllTextures(): boolean {
    return this.broadcastMsg(BroadcastMsg.RELOAD_TEXTURES, ReloadTexturesMode.ALL);
  }

  reloadTexture(carIdx = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.RELOAD_TEXTURES, ReloadTexturesMode.CAR_IDX, carIdx);
  }

  chatCommand(chatCommandMode = ChatCommandMode.BEGIN_CHAT): boolean {
    return this.broadcastMsg(BroadcastMsg.CHAT_COMMAND, chatCommandMode);
  }

  chatCommandMacro(macroNum = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.CHAT_COMMAND, ChatCommandMode.MACRO, macroNum);
  }

  pitCommand(pitCommandMode = PitCommandMode.CLEAR, variable = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.PIT_COMMAND, pitCommandMode, variable);
  }

  telemCommand(telemCommandMode = TelemCommandMode.STOP): boolean {
    return this.broadcastMsg(BroadcastMsg.TELEM_COMMAND, telemCommandMode);
  }

  ffbCommand(ffbCommandMode = FFBCommandMode.FFB_COMMAND_MAX_FORCE, value = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.FFB_COMMAND, ffbCommandMode, Math.floor(value * 65536));
  }

  replaySearchSessionTime(sessionNum = 0, sessionTimeMs = 0): boolean {
    return this.broadcastMsg(BroadcastMsg.REPLAY_SEARCH_SESSION_TIME, sessionNum, sessionTimeMs);
  }

  videoCapture(videoCaptureMode = VideoCaptureMode.TRIGGER_SCREEN_SHOT): boolean {
    return this.broadcastMsg(BroadcastMsg.VIDEO_CAPTURE, videoCaptureMode);
  }
}

export function createIRSDK(options?: IRSDKOptions): IRSDK {
  return new IRSDK(options);
}
