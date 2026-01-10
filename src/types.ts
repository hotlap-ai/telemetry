import type { VarType } from './constants';

export interface VarHeader {
  type: VarType;
  offset: number;
  count: number;
  countAsTime: boolean;
  name: string;
  desc: string;
  unit: string;
}

export interface VarBuffer {
  tickCount: number;
  bufOffset: number;
}

export interface Header {
  version: number;
  status: number;
  tickRate: number;
  sessionInfoUpdate: number;
  sessionInfoLen: number;
  sessionInfoOffset: number;
  numVars: number;
  varHeaderOffset: number;
  numBuf: number;
  bufLen: number;
  varBuf: VarBuffer[];
}

export interface DiskSubHeader {
  sessionStartDate: bigint;
  sessionStartTime: number;
  sessionEndTime: number;
  sessionLapCount: number;
  sessionRecordCount: number;
}

export interface SessionInfo {
  [key: string]: unknown;
}

export interface WeekendInfo {
  TrackName: string;
  TrackID: number;
  TrackLength: string;
  TrackDisplayName: string;
  TrackDisplayShortName: string;
  TrackConfigName: string;
  TrackCity: string;
  TrackCountry: string;
  TrackAltitude: string;
  TrackLatitude: string;
  TrackLongitude: string;
  TrackNorthOffset: string;
  TrackNumTurns: number;
  TrackPitSpeedLimit: string;
  TrackType: string;
  TrackDirection: string;
  TrackWeatherType: string;
  TrackSkies: string;
  TrackSurfaceTemp: string;
  TrackAirTemp: string;
  TrackAirPressure: string;
  TrackWindVel: string;
  TrackWindDir: string;
  TrackRelativeHumidity: string;
  TrackFogLevel: string;
  TrackCleanup: number;
  TrackDynamicTrack: number;
  TrackVersion: string;
  SeriesID: number;
  SeasonID: number;
  SessionID: number;
  SubSessionID: number;
  LeagueID: number;
  Official: number;
  RaceWeek: number;
  EventType: string;
  Category: string;
  SimMode: string;
  TeamRacing: number;
  MinDrivers: number;
  MaxDrivers: number;
  DCRuleSet: string;
  QualifierMustStartRace: number;
  NumCarClasses: number;
  NumCarTypes: number;
  HeatRacing: number;
  BuildType: string;
  BuildTarget: string;
  BuildVersion: string;
}

export interface DriverInfo {
  DriverCarIdx: number;
  DriverUserID: number;
  PaceCarIdx: number;
  DriverHeadPosX: number;
  DriverHeadPosY: number;
  DriverHeadPosZ: number;
  DriverCarIsElectric: number;
  DriverCarIdleRPM: number;
  DriverCarRedLine: number;
  DriverCarEngCylinderCount: number;
  DriverCarFuelKgPerLtr: number;
  DriverCarFuelMaxLtr: number;
  DriverCarMaxFuelPct: number;
  DriverCarGearNumForward: number;
  DriverCarGearNeutral: number;
  DriverCarGearReverse: number;
  DriverCarSLFirstRPM: number;
  DriverCarSLShiftRPM: number;
  DriverCarSLLastRPM: number;
  DriverCarSLBlinkRPM: number;
  DriverCarVersion: string;
  DriverPitTrkPct: number;
  DriverCarEstLapTime: number;
  DriverSetupName: string;
  DriverSetupIsModified: number;
  DriverSetupLoadTypeName: string;
  DriverSetupPassedTech: number;
  DriverIncidentCount: number;
  Drivers: Driver[];
}

export interface Driver {
  CarIdx: number;
  UserName: string;
  AbbrevName: string;
  Initials: string;
  UserID: number;
  TeamID: number;
  TeamName: string;
  CarNumber: string;
  CarNumberRaw: number;
  CarPath: string;
  CarClassID: number;
  CarID: number;
  CarIsPaceCar: number;
  CarIsAI: number;
  CarIsElectric: number;
  CarScreenName: string;
  CarScreenNameShort: string;
  CarClassShortName: string;
  CarClassRelSpeed: number;
  CarClassLicenseLevel: number;
  CarClassMaxFuelPct: string;
  CarClassWeightPenalty: string;
  CarClassPowerAdjust: string;
  CarClassDryTireSetLimit: string;
  CarClassColor: number;
  CarClassEstLapTime: number;
  IRating: number;
  LicLevel: number;
  LicSubLevel: number;
  LicString: string;
  LicColor: number;
  IsSpectator: number;
  CarDesignStr: string;
  HelmetDesignStr: string;
  SuitDesignStr: string;
  CarNumberDesignStr: string;
  CarSponsor_1: number;
  CarSponsor_2: number;
  CurDriverIncidentCount: number;
  TeamIncidentCount: number;
}

export interface SessionInfoData {
  Sessions: Session[];
}

export interface Session {
  SessionNum: number;
  SessionLaps: string;
  SessionTime: string;
  SessionNumLapsToAvg: number;
  SessionType: string;
  SessionTrackRubberState: string;
  SessionName: string;
  SessionSubType: string;
  SessionSkipped: number;
  SessionRunGroupsUsed: number;
  SessionEnforceTireCompoundChange: number;
  ResultsPositions: ResultPosition[];
  ResultsFastestLap: FastestLap[];
  ResultsAverageLapTime: number;
  ResultsNumCautionFlags: number;
  ResultsNumCautionLaps: number;
  ResultsNumLeadChanges: number;
  ResultsLapsComplete: number;
  ResultsOfficial: number;
}

export interface ResultPosition {
  Position: number;
  ClassPosition: number;
  CarIdx: number;
  Lap: number;
  Time: number;
  FastestLap: number;
  FastestTime: number;
  LastTime: number;
  LapsLed: number;
  LapsComplete: number;
  JokerLapsComplete: number;
  LapsDriven: number;
  Incidents: number;
  ReasonOutId: number;
  ReasonOutStr: string;
}

export interface FastestLap {
  CarIdx: number;
  FastestLap: number;
  FastestTime: number;
}

export type TelemetryValue = number | number[] | boolean | boolean[];

export interface TelemetryData {
  [key: string]: TelemetryValue;
}
