export const VERSION = '1.0.0';

export const SIM_STATUS_URL = 'http://127.0.0.1:32034/get_sim_status?object=simStatus';
export const DATA_VALID_EVENT_NAME = 'Local\IRSDKDataValidEvent';
export const MEMMAPFILE = 'Local\IRSDKMemMapFileName';
export const MEMMAPFILESIZE = 1164 * 1024;
export const BROADCASTMSGNAME = 'IRSDK_BROADCASTMSG';

export const VAR_TYPE_SIZES = [1, 1, 4, 4, 4, 8] as const;
export type VarType = 0 | 1 | 2 | 3 | 4 | 5;

export const HEADER_SIZE = 112;
export const VAR_HEADER_SIZE = 144;
export const VAR_BUFFER_SIZE = 16;
export const DISK_SUB_HEADER_OFFSET = 112;
export const DISK_SUB_HEADER_SIZE = 32;

export const YAML_CODE_PAGE = 'windows-1252';

export const StatusField = {
  STATUS_CONNECTED: 1,
} as const;

export const EngineWarnings = {
  WATER_TEMP_WARNING: 0x01,
  FUEL_PRESSURE_WARNING: 0x02,
  OIL_PRESSURE_WARNING: 0x04,
  ENGINE_STALLED: 0x08,
  PIT_SPEED_LIMITER: 0x10,
  REV_LIMITER_ACTIVE: 0x20,
  OIL_TEMP_WARNING: 0x40,
} as const;

export const Flags = {
  CHECKERED: 0x0001,
  WHITE: 0x0002,
  GREEN: 0x0004,
  YELLOW: 0x0008,
  RED: 0x0010,
  BLUE: 0x0020,
  DEBRIS: 0x0040,
  CROSSED: 0x0080,
  YELLOW_WAVING: 0x0100,
  ONE_LAP_TO_GREEN: 0x0200,
  GREEN_HELD: 0x0400,
  TEN_TO_GO: 0x0800,
  FIVE_TO_GO: 0x1000,
  RANDOM_WAVING: 0x2000,
  CAUTION: 0x4000,
  CAUTION_WAVING: 0x8000,
  BLACK: 0x010000,
  DISQUALIFY: 0x020000,
  SERVICIBLE: 0x040000,
  FURLED: 0x080000,
  REPAIR: 0x100000,
  START_HIDDEN: 0x10000000,
  START_READY: 0x20000000,
  START_SET: 0x40000000,
  START_GO: 0x80000000,
} as const;

export const TrkLoc = {
  NOT_IN_WORLD: -1,
  OFF_TRACK: 0,
  IN_PIT_STALL: 1,
  APPROACHING_PITS: 2,
  ON_TRACK: 3,
} as const;

export const TrkSurf = {
  NOT_IN_WORLD: -1,
  UNDEFINED: 0,
  ASPHALT_1: 1,
  ASPHALT_2: 2,
  ASPHALT_3: 3,
  ASPHALT_4: 4,
  CONCRETE_1: 5,
  CONCRETE_2: 6,
  RACING_DIRT_1: 7,
  RACING_DIRT_2: 8,
  PAINT_1: 9,
  PAINT_2: 10,
  RUMBLE_1: 11,
  RUMBLE_2: 12,
  RUMBLE_3: 13,
  RUMBLE_4: 14,
  GRASS_1: 15,
  GRASS_2: 16,
  GRASS_3: 17,
  GRASS_4: 18,
  DIRT_1: 19,
  DIRT_2: 20,
  DIRT_3: 21,
  DIRT_4: 22,
  SAND: 23,
  GRAVEL_1: 24,
  GRAVEL_2: 25,
  GRASSCRETE: 26,
  ASTROTURF: 27,
} as const;

export const SessionState = {
  INVALID: 0,
  GET_IN_CAR: 1,
  WARMUP: 2,
  PARADE_LAPS: 3,
  RACING: 4,
  CHECKERED: 5,
  COOL_DOWN: 6,
} as const;

export const CameraState = {
  IS_SESSION_SCREEN: 0x0001,
  IS_SCENIC_ACTIVE: 0x0002,
  CAM_TOOL_ACTIVE: 0x0004,
  UI_HIDDEN: 0x0008,
  USE_AUTO_SHOT_SELECTION: 0x0010,
  USE_TEMPORARY_EDITS: 0x0020,
  USE_KEY_ACCELERATION: 0x0040,
  USE_KEY10X_ACCELERATION: 0x0080,
  USE_MOUSE_AIM_MODE: 0x0100,
} as const;

export const BroadcastMsg = {
  CAM_SWITCH_POS: 0,
  CAM_SWITCH_NUM: 1,
  CAM_SET_STATE: 2,
  REPLAY_SET_PLAY_SPEED: 3,
  REPLAY_SET_PLAY_POSITION: 4,
  REPLAY_SEARCH: 5,
  REPLAY_SET_STATE: 6,
  RELOAD_TEXTURES: 7,
  CHAT_COMMAND: 8,
  PIT_COMMAND: 9,
  TELEM_COMMAND: 10,
  FFB_COMMAND: 11,
  REPLAY_SEARCH_SESSION_TIME: 12,
  VIDEO_CAPTURE: 13,
} as const;

export const ChatCommandMode = {
  MACRO: 0,
  BEGIN_CHAT: 1,
  REPLY: 2,
  CANCEL: 3,
} as const;

export const PitCommandMode = {
  CLEAR: 0,
  WS: 1,
  FUEL: 2,
  LF: 3,
  RF: 4,
  LR: 5,
  RR: 6,
  CLEAR_TIRES: 7,
  FR: 8,
  CLEAR_WS: 9,
  CLEAR_FR: 10,
  CLEAR_FUEL: 11,
} as const;

export const TelemCommandMode = {
  STOP: 0,
  START: 1,
  RESTART: 2,
} as const;

export const RpyStateMode = {
  ERASE_TAPE: 0,
} as const;

export const ReloadTexturesMode = {
  ALL: 0,
  CAR_IDX: 1,
} as const;

export const RpySrchMode = {
  TO_START: 0,
  TO_END: 1,
  PREV_SESSION: 2,
  NEXT_SESSION: 3,
  PREV_LAP: 4,
  NEXT_LAP: 5,
  PREV_FRAME: 6,
  NEXT_FRAME: 7,
  PREV_INCIDENT: 8,
  NEXT_INCIDENT: 9,
} as const;

export const RpyPosMode = {
  BEGIN: 0,
  CURRENT: 1,
  END: 2,
} as const;

export const CsMode = {
  AT_INCIDENT: -3,
  AT_LEADER: -2,
  AT_EXCITING: -1,
} as const;

export const PitSvFlags = {
  LF_TIRE_CHANGE: 0x01,
  RF_TIRE_CHANGE: 0x02,
  LR_TIRE_CHANGE: 0x04,
  RR_TIRE_CHANGE: 0x08,
  FUEL_FILL: 0x10,
  WINDSHIELD_TEAROFF: 0x20,
  FAST_REPAIR: 0x40,
} as const;

export const PitSvStatus = {
  NONE: 0,
  IN_PROGRESS: 1,
  COMPLETE: 2,
  TOO_FAR_LEFT: 100,
  TOO_FAR_RIGHT: 101,
  TOO_FAR_FORWARD: 102,
  TOO_FAR_BACK: 103,
  BAD_ANGLE: 104,
  CANT_FIX_THAT: 105,
} as const;

export const PaceMode = {
  SINGLE_FILE_START: 0,
  DOUBLE_FILE_START: 1,
  SINGLE_FILE_RESTART: 2,
  DOUBLE_FILE_RESTART: 3,
  NOT_PACING: 4,
} as const;

export const PaceFlags = {
  END_OF_LINE: 0x0001,
  FREE_PASS: 0x0002,
  WAVED_AROUND: 0x0004,
} as const;

export const CarLeftRight = {
  OFF: 0,
  CLEAR: 1,
  CAR_LEFT: 2,
  CAR_RIGHT: 3,
  CAR_LEFT_RIGHT: 4,
  TWO_CARS_LEFT: 5,
  TWO_CARS_RIGHT: 6,
} as const;

export const FFBCommandMode = {
  FFB_COMMAND_MAX_FORCE: 0,
} as const;

export const VideoCaptureMode = {
  TRIGGER_SCREEN_SHOT: 0,
  START_VIDEO_CAPTURE: 1,
  END_VIDEO_CAPTURE: 2,
  TOGGLE_VIDEO_CAPTURE: 3,
  SHOW_VIDEO_TIMER: 4,
  HIDE_VIDEO_TIMER: 5,
} as const;

export const TrackWetness = {
  UNKNOWN: 0,
  DRY: 1,
  MOSTLY_DRY: 2,
  VERY_LIGHTLY_WET: 3,
  LIGHTLY_WET: 4,
  MODERATELY_WET: 5,
  VERY_WET: 6,
  EXTREMELY_WET: 7,
} as const;
