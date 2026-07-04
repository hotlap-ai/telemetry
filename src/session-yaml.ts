/**
 * Canonical iRacing session-YAML decoding, parsing, and metadata resolution
 * (RFC-0001 C5). This is THE implementation all HotLap.ai surfaces must use —
 * it replaces five independent regex-scraping copies across the Edge Functions
 * and UI.
 *
 * Designed for both whole-file consumers (IBT class) and range-download
 * consumers (Edge Functions that fetch only the header + YAML byte ranges):
 *
 *   const { sessionInfoOffset, sessionInfoLen } = readSessionInfoRange(headerBytes);
 *   // ...range-download [sessionInfoOffset, sessionInfoOffset+sessionInfoLen)...
 *   const meta = sessionMetadataFromYamlBytes(yamlBytes);
 *
 * RUNTIME NEUTRALITY: no Bun/Deno/Node APIs — browser, Deno, and Bun alike.
 */
import { parse as parseYamlLib } from 'yaml';

// Pre-compiled regexes for YAML cleaning (allocated once, reused forever)
const YAML_SPECIAL_FIELDS_REGEX = /((?:DriverSetupName|UserName|TeamName|AbbrevName|Initials): )(.*)/g;
const YAML_COMMA_VALUE_REGEX = /(\w+: )(,.*)/g;

/**
 * Fast single-pass YAML cleaning function.
 * Combines multiple string operations to reduce intermediate allocations.
 */
export function cleanYamlFast(yaml: string): string {
  let cleaned = '';
  for (let i = 0; i < yaml.length; i++) {
    const code = yaml.charCodeAt(i);
    // Skip problematic Windows-1252 characters and non-printable chars
    if (code === 0x81 || code === 0x8d || code === 0x8f || code === 0x90 || code === 0x9d) {
      cleaned += ' ';
    } else if (
      code === 0x09 || code === 0x0a || code === 0x0d || // Tab, LF, CR
      (code >= 0x20 && code <= 0x7e) || // Printable ASCII
      (code >= 0xa0 && code <= 0xff)    // Extended ASCII
    ) {
      cleaned += yaml[i];
    }
  }

  cleaned = cleaned.replace(YAML_SPECIAL_FIELDS_REGEX, (_, prefix, value) => {
    const escaped = value.replace(/["\\]/g, '\\$&');
    return `${prefix}"${escaped}"`;
  });

  return cleaned.replace(YAML_COMMA_VALUE_REGEX, '$1"$2"');
}

// ---------------------------------------------------------------------------
// Byte-level helpers
// ---------------------------------------------------------------------------

/**
 * Read the session-info byte range from the .ibt fixed header (first 48+
 * bytes are sufficient). For consumers that range-download instead of
 * loading the whole file.
 */
export function readSessionInfoRange(headerBytes: ArrayBuffer | Uint8Array): {
  sessionInfoLen: number;
  sessionInfoOffset: number;
} {
  const view =
    headerBytes instanceof Uint8Array
      ? new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength)
      : new DataView(headerBytes);
  return {
    sessionInfoLen: view.getInt32(16, true),
    sessionInfoOffset: view.getInt32(20, true),
  };
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const win1252Decoder = new TextDecoder('windows-1252');

/**
 * Canonical text decode (RFC C5/D5): UTF-8 first; if replacement characters
 * appear, fall back to windows-1252 (older iRacing builds and non-ASCII
 * driver/team names). A plain lossy UTF-8 decode corrupts those names —
 * that was divergence D5.
 */
export function decodeSessionYaml(bytes: Uint8Array): string {
  // Trim at the first NUL — the YAML region is NUL-padded in some files.
  let end = bytes.length;
  const nul = bytes.indexOf(0);
  if (nul !== -1) end = nul;
  const slice = bytes.subarray(0, end);
  const utf8 = utf8Decoder.decode(slice);
  if (utf8.includes('�')) {
    return win1252Decoder.decode(slice);
  }
  return utf8;
}

// ---------------------------------------------------------------------------
// Parsed document types (loose — iRacing YAML shape varies by sim build)
// ---------------------------------------------------------------------------

export interface SessionYamlDoc {
  WeekendInfo?: Record<string, unknown>;
  DriverInfo?: {
    DriverCarIdx?: number;
    Drivers?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  SplitTimeInfo?: { Sectors?: Array<{ SectorNum?: number; SectorStartPct?: number }> };
  SessionInfo?: { Sessions?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

/** Clean + parse the raw YAML text with a real YAML parser (never regex). */
export function parseSessionYaml(raw: string): SessionYamlDoc | null {
  try {
    const doc = parseYamlLib(cleanYamlFast(raw));
    return doc && typeof doc === 'object' ? (doc as SessionYamlDoc) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolved metadata (RFC C5)
// ---------------------------------------------------------------------------

export interface ResolvedSessionEntry {
  sessionNum: number | null;
  /** Full string, e.g. "Offline Testing", "Lone Qualify" — never truncated. */
  sessionType: string | null;
  sessionName: string | null;
  raw: Record<string, unknown>;
}

export interface SessionMetadata {
  // Track
  trackId: number | null;
  trackName: string | null;          // TrackDisplayName ?? TrackName
  trackConfigName: string | null;
  trackLengthKm: number | null;      // TrackLength ?? TrackLengthOfficial, parsed
  trackNumTurns: number | null;
  // Event
  eventType: string | null;          // WeekendInfo.EventType (event-level context)
  category: string | null;
  seriesId: number | null;
  seasonId: number | null;
  sessionId: number | null;
  subSessionId: number | null;
  raceWeek: number | null;
  official: boolean | null;
  // Recording driver + car
  driverCarIdx: number;
  driverName: string | null;
  driverUserId: number | null;
  carId: number | null;
  carScreenName: string | null;
  carPath: string | null;
  carClassId: number | null;
  carNumber: string | null;
  teamName: string | null;
  // Sessions list (for SessionNum-channel resolution and results access)
  sessions: ResolvedSessionEntry[];
  /** Raw parsed doc for specialized consumers (results positions, sectors…). */
  doc: SessionYamlDoc;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseTrackLengthKm(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const m = value.match(/([\d.]+)\s*km/i);
  if (!m) return null;
  const km = parseFloat(m[1]!);
  return Number.isFinite(km) && km > 0 ? km : null;
}

export function resolveSessionMetadata(doc: SessionYamlDoc): SessionMetadata {
  const w = doc.WeekendInfo ?? {};
  const opts = (w.WeekendOptions ?? {}) as Record<string, unknown>;
  const driverInfo = doc.DriverInfo ?? {};
  const driverCarIdx = num(driverInfo.DriverCarIdx) ?? 0;
  const driver =
    driverInfo.Drivers?.find((d) => num(d.CarIdx) === driverCarIdx) ?? undefined;

  const sessions: ResolvedSessionEntry[] = (doc.SessionInfo?.Sessions ?? []).map((s) => ({
    sessionNum: num(s.SessionNum),
    sessionType: str(s.SessionType),
    sessionName: str(s.SessionName),
    raw: s,
  }));

  return {
    trackId: num(w.TrackID),
    trackName: str(w.TrackDisplayName) ?? str(w.TrackName),
    trackConfigName: str(w.TrackConfigName),
    trackLengthKm:
      parseTrackLengthKm(w.TrackLength) ?? parseTrackLengthKm(w.TrackLengthOfficial),
    trackNumTurns: num(w.TrackNumTurns),
    eventType: str(w.EventType),
    category: str(w.Category),
    seriesId: num(w.SeriesID),
    seasonId: num(w.SeasonID),
    sessionId: num(w.SessionID),
    subSessionId: num(w.SubSessionID),
    raceWeek: num(w.RaceWeek) ?? num(opts.RaceWeek),
    official: w.Official == null ? null : num(w.Official) === 1,
    driverCarIdx,
    driverName: str(driver?.UserName),
    driverUserId: num(driver?.UserID),
    carId: num(driver?.CarID),
    carScreenName: str(driver?.CarScreenName),
    carPath: str(driver?.CarPath),
    carClassId: num(driver?.CarClassID),
    carNumber: str(driver?.CarNumber),
    teamName: str(driver?.TeamName),
    sessions,
    doc,
  };
}

/**
 * Session-type resolution per RFC C5: the type of the session the telemetry
 * was recorded in is Sessions[n].SessionType where n comes from the
 * SessionNum CHANNEL — never "the first SessionType in the document" (that
 * was divergence D4) and never WeekendInfo.EventType (kept separately).
 */
export function sessionTypeForSessionNum(
  meta: Pick<SessionMetadata, 'sessions'>,
  sessionNum: number
): string | null {
  return meta.sessions.find((s) => s.sessionNum === sessionNum)?.sessionType ?? null;
}

/** Convenience: raw YAML byte range → resolved metadata (or null on parse failure). */
export function sessionMetadataFromYamlBytes(bytes: Uint8Array): SessionMetadata | null {
  const doc = parseSessionYaml(decodeSessionYaml(bytes));
  return doc ? resolveSessionMetadata(doc) : null;
}
