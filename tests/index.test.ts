import { describe, it, expect } from 'bun:test';
import * as telemetry from '../src/index';

describe('Module Exports', () => {
  describe('IBT exports', () => {
    it('should export IBT class', () => {
      expect(telemetry.IBT).toBeDefined();
      expect(typeof telemetry.IBT).toBe('function');
    });

    it('should export parseIbt function', () => {
      expect(telemetry.parseIbt).toBeDefined();
      expect(typeof telemetry.parseIbt).toBe('function');
    });

    it('should export parseIbtBuffer function', () => {
      expect(telemetry.parseIbtBuffer).toBeDefined();
      expect(typeof telemetry.parseIbtBuffer).toBe('function');
    });
  });

  describe('IRSDK exports', () => {
    it('should export IRSDK class', () => {
      expect(telemetry.IRSDK).toBeDefined();
      expect(typeof telemetry.IRSDK).toBe('function');
    });

    it('should export createIRSDK function', () => {
      expect(telemetry.createIRSDK).toBeDefined();
      expect(typeof telemetry.createIRSDK).toBe('function');
    });
  });

  describe('Constants exports', () => {
    it('should export VERSION', () => {
      expect(telemetry.VERSION).toBeDefined();
    });

    it('should export memory map constants', () => {
      expect(telemetry.MEMMAPFILE).toBeDefined();
      expect(telemetry.MEMMAPFILESIZE).toBeDefined();
    });

    it('should export size constants', () => {
      expect(telemetry.HEADER_SIZE).toBeDefined();
      expect(telemetry.VAR_HEADER_SIZE).toBeDefined();
      expect(telemetry.VAR_TYPE_SIZES).toBeDefined();
    });

    it('should export StatusField', () => {
      expect(telemetry.StatusField).toBeDefined();
      expect(telemetry.StatusField.STATUS_CONNECTED).toBe(1);
    });

    it('should export EngineWarnings', () => {
      expect(telemetry.EngineWarnings).toBeDefined();
    });

    it('should export Flags', () => {
      expect(telemetry.Flags).toBeDefined();
    });

    it('should export TrkLoc', () => {
      expect(telemetry.TrkLoc).toBeDefined();
    });

    it('should export TrkSurf', () => {
      expect(telemetry.TrkSurf).toBeDefined();
    });

    it('should export SessionState', () => {
      expect(telemetry.SessionState).toBeDefined();
    });

    it('should export CameraState', () => {
      expect(telemetry.CameraState).toBeDefined();
    });

    it('should export BroadcastMsg', () => {
      expect(telemetry.BroadcastMsg).toBeDefined();
    });

    it('should export ChatCommandMode', () => {
      expect(telemetry.ChatCommandMode).toBeDefined();
    });

    it('should export PitCommandMode', () => {
      expect(telemetry.PitCommandMode).toBeDefined();
    });

    it('should export TelemCommandMode', () => {
      expect(telemetry.TelemCommandMode).toBeDefined();
    });

    it('should export RpySrchMode', () => {
      expect(telemetry.RpySrchMode).toBeDefined();
    });

    it('should export RpyPosMode', () => {
      expect(telemetry.RpyPosMode).toBeDefined();
    });

    it('should export PitSvFlags', () => {
      expect(telemetry.PitSvFlags).toBeDefined();
    });

    it('should export PitSvStatus', () => {
      expect(telemetry.PitSvStatus).toBeDefined();
    });

    it('should export CarLeftRight', () => {
      expect(telemetry.CarLeftRight).toBeDefined();
    });

    it('should export VideoCaptureMode', () => {
      expect(telemetry.VideoCaptureMode).toBeDefined();
    });

    it('should export TrackWetness', () => {
      expect(telemetry.TrackWetness).toBeDefined();
    });
  });

  describe('Binary reader exports', () => {
    it('should export read functions', () => {
      expect(telemetry.readInt32LE).toBeDefined();
      expect(telemetry.readUint32LE).toBeDefined();
      expect(telemetry.readFloat32LE).toBeDefined();
      expect(telemetry.readFloat64LE).toBeDefined();
      expect(telemetry.readBigUint64LE).toBeDefined();
      expect(telemetry.readBoolLE).toBeDefined();
      expect(telemetry.readCharLE).toBeDefined();
      expect(telemetry.readString).toBeDefined();
    });

    it('should export parse functions', () => {
      expect(telemetry.parseHeader).toBeDefined();
      expect(telemetry.parseVarHeader).toBeDefined();
      expect(telemetry.parseDiskSubHeader).toBeDefined();
      expect(telemetry.parseVarHeaders).toBeDefined();
    });

    it('should export utility functions', () => {
      expect(telemetry.readVarValue).toBeDefined();
      expect(telemetry.readVarValueBatch).toBeDefined();
      expect(telemetry.getLatestVarBuffer).toBeDefined();
    });
  });
});

describe('Class Instantiation', () => {
  it('should create IBT instance', () => {
    const ibt = new telemetry.IBT();
    expect(ibt).toBeInstanceOf(telemetry.IBT);
  });

  it('should create IRSDK instance', () => {
    const ir = telemetry.createIRSDK();
    expect(ir).toBeInstanceOf(telemetry.IRSDK);
  });

  it('should create IRSDK with options', () => {
    const ir = telemetry.createIRSDK({ parseYamlAsync: true });
    expect(ir).toBeInstanceOf(telemetry.IRSDK);
  });
});
