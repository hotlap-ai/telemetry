import { describe, it, expect } from 'bun:test';
import {
  VERSION,
  SIM_STATUS_URL,
  DATA_VALID_EVENT_NAME,
  MEMMAPFILE,
  MEMMAPFILESIZE,
  BROADCASTMSGNAME,
  VAR_TYPE_SIZES,
  HEADER_SIZE,
  VAR_HEADER_SIZE,
  VAR_BUFFER_SIZE,
  DISK_SUB_HEADER_OFFSET,
  DISK_SUB_HEADER_SIZE,
  StatusField,
  EngineWarnings,
  Flags,
  TrkLoc,
  TrkSurf,
  SessionState,
  CameraState,
  BroadcastMsg,
  ChatCommandMode,
  PitCommandMode,
  TelemCommandMode,
  RpyStateMode,
  ReloadTexturesMode,
  RpySrchMode,
  RpyPosMode,
  CsMode,
  PitSvFlags,
  PitSvStatus,
  PaceMode,
  PaceFlags,
  CarLeftRight,
  FFBCommandMode,
  VideoCaptureMode,
  TrackWetness,
} from '../src/constants';

describe('Constants', () => {
  describe('Version and URLs', () => {
    it('should have VERSION defined', () => {
      expect(VERSION).toBeDefined();
      expect(typeof VERSION).toBe('string');
    });

    it('should have correct SIM_STATUS_URL', () => {
      expect(SIM_STATUS_URL).toBe('http://127.0.0.1:32034/get_sim_status?object=simStatus');
    });

    it('should have correct event names', () => {
      expect(DATA_VALID_EVENT_NAME).toBe('Local\IRSDKDataValidEvent');
      expect(MEMMAPFILE).toBe('Local\IRSDKMemMapFileName');
      expect(BROADCASTMSGNAME).toBe('IRSDK_BROADCASTMSG');
    });

    it('should have correct memory map size', () => {
      expect(MEMMAPFILESIZE).toBe(1164 * 1024);
    });
  });

  describe('Binary Layout Constants', () => {
    it('should have correct VAR_TYPE_SIZES', () => {
      expect(VAR_TYPE_SIZES).toEqual([1, 1, 4, 4, 4, 8]);
      expect(VAR_TYPE_SIZES[0]).toBe(1);  // char
      expect(VAR_TYPE_SIZES[1]).toBe(1);  // bool
      expect(VAR_TYPE_SIZES[2]).toBe(4);  // int32
      expect(VAR_TYPE_SIZES[3]).toBe(4);  // uint32 (bitfield)
      expect(VAR_TYPE_SIZES[4]).toBe(4);  // float32
      expect(VAR_TYPE_SIZES[5]).toBe(8);  // float64
    });

    it('should have correct header sizes', () => {
      expect(HEADER_SIZE).toBe(112);
      expect(VAR_HEADER_SIZE).toBe(144);
      expect(VAR_BUFFER_SIZE).toBe(16);
      expect(DISK_SUB_HEADER_OFFSET).toBe(112);
      expect(DISK_SUB_HEADER_SIZE).toBe(32);
    });
  });

  describe('StatusField', () => {
    it('should have STATUS_CONNECTED', () => {
      expect(StatusField.STATUS_CONNECTED).toBe(1);
    });
  });

  describe('EngineWarnings', () => {
    it('should have all warning flags', () => {
      expect(EngineWarnings.WATER_TEMP_WARNING).toBe(0x01);
      expect(EngineWarnings.FUEL_PRESSURE_WARNING).toBe(0x02);
      expect(EngineWarnings.OIL_PRESSURE_WARNING).toBe(0x04);
      expect(EngineWarnings.ENGINE_STALLED).toBe(0x08);
      expect(EngineWarnings.PIT_SPEED_LIMITER).toBe(0x10);
      expect(EngineWarnings.REV_LIMITER_ACTIVE).toBe(0x20);
      expect(EngineWarnings.OIL_TEMP_WARNING).toBe(0x40);
    });

    it('should have unique bit flags', () => {
      const values = Object.values(EngineWarnings);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });
  });

  describe('Flags', () => {
    it('should have racing flags', () => {
      expect(Flags.CHECKERED).toBe(0x0001);
      expect(Flags.WHITE).toBe(0x0002);
      expect(Flags.GREEN).toBe(0x0004);
      expect(Flags.YELLOW).toBe(0x0008);
      expect(Flags.RED).toBe(0x0010);
      expect(Flags.BLUE).toBe(0x0020);
    });

    it('should have start flags', () => {
      expect(Flags.START_HIDDEN).toBe(0x10000000);
      expect(Flags.START_READY).toBe(0x20000000);
      expect(Flags.START_SET).toBe(0x40000000);
      expect(Flags.START_GO).toBe(0x80000000);
    });
  });

  describe('TrkLoc', () => {
    it('should have all track locations', () => {
      expect(TrkLoc.NOT_IN_WORLD).toBe(-1);
      expect(TrkLoc.OFF_TRACK).toBe(0);
      expect(TrkLoc.IN_PIT_STALL).toBe(1);
      expect(TrkLoc.APPROACHING_PITS).toBe(2);
      expect(TrkLoc.ON_TRACK).toBe(3);
    });
  });

  describe('TrkSurf', () => {
    it('should have track surface types', () => {
      expect(TrkSurf.NOT_IN_WORLD).toBe(-1);
      expect(TrkSurf.UNDEFINED).toBe(0);
      expect(TrkSurf.ASPHALT_1).toBe(1);
      expect(TrkSurf.GRASS_1).toBe(15);
      expect(TrkSurf.SAND).toBe(23);
    });
  });

  describe('SessionState', () => {
    it('should have all session states', () => {
      expect(SessionState.INVALID).toBe(0);
      expect(SessionState.GET_IN_CAR).toBe(1);
      expect(SessionState.WARMUP).toBe(2);
      expect(SessionState.PARADE_LAPS).toBe(3);
      expect(SessionState.RACING).toBe(4);
      expect(SessionState.CHECKERED).toBe(5);
      expect(SessionState.COOL_DOWN).toBe(6);
    });
  });

  describe('CameraState', () => {
    it('should have camera state flags', () => {
      expect(CameraState.IS_SESSION_SCREEN).toBe(0x0001);
      expect(CameraState.IS_SCENIC_ACTIVE).toBe(0x0002);
      expect(CameraState.CAM_TOOL_ACTIVE).toBe(0x0004);
      expect(CameraState.UI_HIDDEN).toBe(0x0008);
    });
  });

  describe('BroadcastMsg', () => {
    it('should have all broadcast message types', () => {
      expect(BroadcastMsg.CAM_SWITCH_POS).toBe(0);
      expect(BroadcastMsg.CAM_SWITCH_NUM).toBe(1);
      expect(BroadcastMsg.CAM_SET_STATE).toBe(2);
      expect(BroadcastMsg.REPLAY_SET_PLAY_SPEED).toBe(3);
      expect(BroadcastMsg.PIT_COMMAND).toBe(9);
      expect(BroadcastMsg.VIDEO_CAPTURE).toBe(13);
    });
  });

  describe('ChatCommandMode', () => {
    it('should have chat command modes', () => {
      expect(ChatCommandMode.MACRO).toBe(0);
      expect(ChatCommandMode.BEGIN_CHAT).toBe(1);
      expect(ChatCommandMode.REPLY).toBe(2);
      expect(ChatCommandMode.CANCEL).toBe(3);
    });
  });

  describe('PitCommandMode', () => {
    it('should have pit command modes', () => {
      expect(PitCommandMode.CLEAR).toBe(0);
      expect(PitCommandMode.WS).toBe(1);
      expect(PitCommandMode.FUEL).toBe(2);
      expect(PitCommandMode.LF).toBe(3);
      expect(PitCommandMode.RF).toBe(4);
      expect(PitCommandMode.LR).toBe(5);
      expect(PitCommandMode.RR).toBe(6);
    });
  });

  describe('TelemCommandMode', () => {
    it('should have telemetry command modes', () => {
      expect(TelemCommandMode.STOP).toBe(0);
      expect(TelemCommandMode.START).toBe(1);
      expect(TelemCommandMode.RESTART).toBe(2);
    });
  });

  describe('RpySrchMode', () => {
    it('should have replay search modes', () => {
      expect(RpySrchMode.TO_START).toBe(0);
      expect(RpySrchMode.TO_END).toBe(1);
      expect(RpySrchMode.PREV_LAP).toBe(4);
      expect(RpySrchMode.NEXT_LAP).toBe(5);
      expect(RpySrchMode.PREV_INCIDENT).toBe(8);
      expect(RpySrchMode.NEXT_INCIDENT).toBe(9);
    });
  });

  describe('RpyPosMode', () => {
    it('should have replay position modes', () => {
      expect(RpyPosMode.BEGIN).toBe(0);
      expect(RpyPosMode.CURRENT).toBe(1);
      expect(RpyPosMode.END).toBe(2);
    });
  });

  describe('PitSvFlags', () => {
    it('should have pit service flags', () => {
      expect(PitSvFlags.LF_TIRE_CHANGE).toBe(0x01);
      expect(PitSvFlags.RF_TIRE_CHANGE).toBe(0x02);
      expect(PitSvFlags.LR_TIRE_CHANGE).toBe(0x04);
      expect(PitSvFlags.RR_TIRE_CHANGE).toBe(0x08);
      expect(PitSvFlags.FUEL_FILL).toBe(0x10);
      expect(PitSvFlags.WINDSHIELD_TEAROFF).toBe(0x20);
      expect(PitSvFlags.FAST_REPAIR).toBe(0x40);
    });
  });

  describe('PitSvStatus', () => {
    it('should have pit service status values', () => {
      expect(PitSvStatus.NONE).toBe(0);
      expect(PitSvStatus.IN_PROGRESS).toBe(1);
      expect(PitSvStatus.COMPLETE).toBe(2);
      expect(PitSvStatus.TOO_FAR_LEFT).toBe(100);
      expect(PitSvStatus.TOO_FAR_RIGHT).toBe(101);
    });
  });

  describe('CarLeftRight', () => {
    it('should have car proximity values', () => {
      expect(CarLeftRight.OFF).toBe(0);
      expect(CarLeftRight.CLEAR).toBe(1);
      expect(CarLeftRight.CAR_LEFT).toBe(2);
      expect(CarLeftRight.CAR_RIGHT).toBe(3);
      expect(CarLeftRight.CAR_LEFT_RIGHT).toBe(4);
      expect(CarLeftRight.TWO_CARS_LEFT).toBe(5);
      expect(CarLeftRight.TWO_CARS_RIGHT).toBe(6);
    });
  });

  describe('VideoCaptureMode', () => {
    it('should have video capture modes', () => {
      expect(VideoCaptureMode.TRIGGER_SCREEN_SHOT).toBe(0);
      expect(VideoCaptureMode.START_VIDEO_CAPTURE).toBe(1);
      expect(VideoCaptureMode.END_VIDEO_CAPTURE).toBe(2);
      expect(VideoCaptureMode.TOGGLE_VIDEO_CAPTURE).toBe(3);
    });
  });

  describe('TrackWetness', () => {
    it('should have track wetness levels', () => {
      expect(TrackWetness.UNKNOWN).toBe(0);
      expect(TrackWetness.DRY).toBe(1);
      expect(TrackWetness.MOSTLY_DRY).toBe(2);
      expect(TrackWetness.VERY_LIGHTLY_WET).toBe(3);
      expect(TrackWetness.LIGHTLY_WET).toBe(4);
      expect(TrackWetness.MODERATELY_WET).toBe(5);
      expect(TrackWetness.VERY_WET).toBe(6);
      expect(TrackWetness.EXTREMELY_WET).toBe(7);
    });
  });
});
