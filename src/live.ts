import { parse as parseYaml } from 'yaml';
import type { Header, VarHeader, TelemetryValue } from './types';
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
  private broadcastMsgId: number | null = null;
  private lastSessionInfoUpdate = 0;
  private workaroundConnectedState = 0;
  private frozenBuffer: Uint8Array | null = null;
  private frozenView: DataView | null = null;
  private frozenBufOffset = 0;
  private testMode = false;
  isInitialized = false;

  constructor(options: IRSDKOptions = {}) {
    this.parseYamlAsync = options.parseYamlAsync ?? false;
  }

  get isConnected(): boolean {
    if (!this.header) return false;

    if (this.header.status === StatusField.STATUS_CONNECTED) {
      this.workaroundConnectedState = 0;
    }
    if (this.workaroundConnectedState === 0 && this.header.status !== StatusField.STATUS_CONNECTED) {
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
      (this.header.status === StatusField.STATUS_CONNECTED || this.workaroundConnectedState === 3)
    );
  }

  get sessionInfoUpdate(): number {
    return this.header?.sessionInfoUpdate ?? 0;
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

    const view = this.frozenView ?? this.sharedMemView;
    if (!view) return null;

    const varBuf = this.frozenView ? { bufOffset: this.frozenBufOffset } : getLatestVarBuffer(this.header.varBuf);
    const offset = varBuf.bufOffset + varHeader.offset;

    return readVarValue(view, offset, varHeader.type, varHeader.count);
  }

  freezeVarBufferLatest(): void {
    this.unfreezeVarBufferLatest();

    if (!this.header || !this.sharedMemBuffer) return;

    this.waitValidDataEvent();
    const varBuf = this.header.varBuf.reduce((a, b) => (a.tickCount > b.tickCount ? a : b));

    this.frozenBufOffset = 0;
    this.frozenBuffer = this.sharedMemBuffer.slice(varBuf.bufOffset, varBuf.bufOffset + this.header.bufLen);
    this.frozenView = new DataView(this.frozenBuffer.buffer);
  }

  unfreezeVarBufferLatest(): void {
    this.frozenBuffer = null;
    this.frozenView = null;
    this.frozenBufOffset = 0;
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

  getSessionInfo<T = unknown>(key: string): T | null {
    if (!this.header || !this.sharedMemBuffer) return null;

    if (this.lastSessionInfoUpdate < this.header.sessionInfoUpdate) {
      this.lastSessionInfoUpdate = this.header.sessionInfoUpdate;
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

    const start = this.header.sessionInfoOffset;
    const len = this.header.sessionInfoLen;
    const raw = readString(this.sharedMemBuffer, start, len);

    const sectionMatch = raw.match(new RegExp(`\n${key}:\n([\\s\\S]*?)(?=\n\n|$)`));
    if (!sectionMatch) return null;

    try {
      const sectionYaml = `${key}:\n${sectionMatch[1]}`;
      const cleaned = this.cleanYaml(sectionYaml);
      const parsed = parseYaml(cleaned);
      const result = parsed?.[key] ?? null;
      this.sessionInfoCache.set(key, { data: result, update: this.lastSessionInfoUpdate });
      return result as T;
    } catch {
      return null;
    }
  }

  private cleanYaml(yaml: string): string {
    let cleaned = yaml
      .replace(/[\x81\x8D\x8F\x90\x9D]/g, ' ')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');

    cleaned = cleaned.replace(
      /((?:DriverSetupName|UserName|TeamName|AbbrevName|Initials): )(.*)/g,
      (_, prefix, value) => {
        const escaped = value.replace(/["\\]/g, '\\$&');
        return `${prefix}"${escaped}"`;
      }
    );

    cleaned = cleaned.replace(/(\w+: )(,.*)/g, '$1"$2"');

    return cleaned;
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
