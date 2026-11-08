import { zipSync } from "fflate"
import { parquetMetadata, parquetRead, type AsyncBuffer } from "hyparquet"
import { parquetWriteBuffer, type ColumnSource } from "hyparquet-writer"
import { LMU_CHANNELS_USED, type LmuRecordingData } from "./normalize"
import { readLmuTables, type LmuRecording, type LmuTableReader, type ReadLmuTablesOptions } from "./reader"

/**
 * LMU bundle: the file HotLap.ai uploads for a Le Mans Ultimate recording.
 *
 * Edge Functions cannot run DuckDB, so the host that can (the desktop agent)
 * reads the recording and packs the tables it needs into a bundle that any
 * JavaScript runtime can read back:
 *
 *   <recording>.lmu.zip   (store-only zip: Parquet is already compressed)
 *     manifest.json       format, version, source file identity, table list
 *     tables/000.parquet  one Parquet file per table, Snappy-compressed
 *
 * `readLmuBundle` turns a bundle back into the same `LmuRecording` that
 * `readLmuTables` returns for the `.duckdb`, so `normalizeLmuRecording` gives
 * identical laps on both. Values are lossless: channel columns are FLOAT
 * when every value round-trips through float32 (LMU writes FLOAT), else
 * DOUBLE; `GPS Time` (session time) is always DOUBLE.
 */

export const LMU_BUNDLE_FORMAT = "hotlap.lmu-bundle"
export const LMU_BUNDLE_VERSION = 1
export const LMU_BUNDLE_EXTENSION = ".lmu.zip"

/**
 * Channels a bundle carries: the ones the normalizer reads today plus the
 * ones we expect to use next, so recordings already uploaded can be
 * re-parsed for them. Every event is carried (events are sparse and tiny).
 * Unfiltered duplicates, FFB, suspension deflection, extra tyre layers and
 * engine temperatures are left out to keep bundles small.
 */
export const LMU_BUNDLE_CHANNELS = [
  ...LMU_CHANNELS_USED,
  "Path Lateral",
  "Track Edge",
  "Total Dist",
  "G Force Vert",
  "Fuel Level",
  "Virtual Energy",
  "SoC",
  "Clutch Pos",
  "Brakes Temp",
  "FrontRideHeight",
  "RearRideHeight",
  "Wheel Speed",
  "Ambient Temperature",
  "Track Temperature",
  "Wind Speed",
  "Wind Heading",
] as const

export type LmuBundleTableKind = "metadata" | "channelsList" | "eventsList" | "channel" | "event"

export interface LmuBundleSource {
  /** The recording's file name, e.g. "Sebring_R_2026-11-07T18_30_00Z.duckdb". */
  fileName: string
  /** SHA-256 (hex) of the original .duckdb: the recording's identity. */
  sha256: string
  sizeBytes: number
}

export interface LmuBundleManifest {
  format: typeof LMU_BUNDLE_FORMAT
  version: number
  /** Who wrote the bundle, e.g. "hotlap-agent 5.3.0". */
  writer: string
  source: LmuBundleSource
  tables: Array<{ name: string; kind: LmuBundleTableKind; file: string }>
}

export interface LmuBundle {
  manifest: LmuBundleManifest
  recording: LmuRecording
}

export class LmuBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LmuBundleError"
  }
}

const MANIFEST = "manifest.json"
const ROW_GROUP_SIZE = 1 << 20

// ---------------------------------------------------------------------------
// Writing

/** Pack a recording (as read from the .duckdb) into a bundle. */
export function packLmuBundle(
  recording: LmuRecordingData,
  source: LmuBundleSource,
  options: { writer?: string } = {},
): Uint8Array {
  const tables: LmuBundleManifest["tables"] = []
  const files: Record<string, Uint8Array> = {}
  const add = (name: string, kind: LmuBundleTableKind, columnData: ColumnSource[]) => {
    const file = `tables/${String(tables.length).padStart(3, "0")}.parquet`
    tables.push({ name, kind, file })
    files[file] = new Uint8Array(
      parquetWriteBuffer({ columnData, rowGroupSize: ROW_GROUP_SIZE, statistics: false, createdBy: "@hotlap.ai/telemetry" }),
    )
  }

  const metadata = Object.entries(recording.metadata)
  add("metadata", "metadata", [
    stringColumn("key", metadata.map(([k]) => k)),
    stringColumn("value", metadata.map(([, v]) => v)),
  ])
  const channels = Object.entries(recording.channels)
  add("channelsList", "channelsList", [
    stringColumn("channelName", channels.map(([name]) => name)),
    { name: "frequency", data: Float64Array.from(channels, ([, c]) => c.frequency), type: "DOUBLE", nullable: false },
    stringColumn("unit", channels.map(([, c]) => c.unit)),
  ])
  const events = Object.entries(recording.events)
  add("eventsList", "eventsList", [
    stringColumn("eventName", events.map(([name]) => name)),
    stringColumn("unit", events.map(([, e]) => e.unit)),
  ])

  for (const [name, channel] of channels) {
    const rows = channel.columns[0]?.length ?? 0
    if (channel.columns.some((c) => c.length !== rows)) throw new LmuBundleError(`Channel "${name}" has columns of different lengths.`)
    add(
      name,
      "channel",
      channel.columns.map((col, i) => floatColumn(channel.columnNames[i] ?? `value${i + 1}`, col, name === "GPS Time")),
    )
  }
  for (const [name, event] of events) {
    const numeric = event.rows.every(([, v]) => typeof v === "number")
    add(name, "event", [
      { name: "ts", data: Float64Array.from(event.rows, ([ts]) => ts), type: "DOUBLE", nullable: false },
      numeric
        ? { name: "value", data: Float64Array.from(event.rows, ([, v]) => v as number), type: "DOUBLE", nullable: false }
        : stringColumn("value", event.rows.map(([, v]) => String(v))),
    ])
  }

  const manifest: LmuBundleManifest = {
    format: LMU_BUNDLE_FORMAT,
    version: LMU_BUNDLE_VERSION,
    writer: options.writer ?? "@hotlap.ai/telemetry",
    source,
    tables,
  }
  return zipSync(
    { [MANIFEST]: new TextEncoder().encode(JSON.stringify(manifest, null, 1)), ...files },
    // Store only, and a fixed timestamp so the same recording packs to the same bytes.
    { level: 0, mtime: new Date(Date.UTC(2020, 0, 1)) },
  )
}

function stringColumn(name: string, values: string[]): ColumnSource {
  return { name, data: values, type: "STRING", nullable: false }
}

function floatColumn(name: string, values: ArrayLike<number>, forceDouble: boolean): ColumnSource {
  let float32 = !forceDouble
  for (let i = 0; float32 && i < values.length; i++) {
    const v = values[i]!
    if (!Number.isNaN(v) && Math.fround(v) !== v) float32 = false
  }
  const data = float32 ? Float32Array.from(values) : Float64Array.from(values)
  return { name, data, type: float32 ? "FLOAT" : "DOUBLE", nullable: false, encoding: "BYTE_STREAM_SPLIT" }
}

// ---------------------------------------------------------------------------
// Reading

/** The manifest alone (cheap: no Parquet is decoded). */
export function readLmuBundleManifest(bytes: Uint8Array): LmuBundleManifest {
  return parseManifest(readStoredZip(bytes))
}

/**
 * Read a bundle back into an `LmuRecording`. `options` limits which channel
 * and event tables are decoded; skipped tables cost nothing.
 */
export async function readLmuBundle(bytes: Uint8Array, options: ReadLmuTablesOptions = {}): Promise<LmuBundle> {
  const entries = readStoredZip(bytes)
  const manifest = parseManifest(entries)
  const fileOf = new Map(manifest.tables.map((t) => [t.name, t.file]))
  const entry = (table: string) => {
    const file = fileOf.get(table)
    const data = file ? entries.get(file) : undefined
    if (!data) throw new LmuBundleError(`Bundle has no data for table "${table}".`)
    return data
  }
  const reader: LmuTableReader = {
    tableNames: async () => manifest.tables.map((t) => t.name),
    columns: (table) => readParquetColumns(entry(table)),
    async rows(table) {
      const { columnNames, columns } = await readParquetColumns(entry(table))
      const count = columns[0]?.length ?? 0
      return Array.from({ length: count }, (_, r) => Object.fromEntries(columnNames.map((c, i) => [c, columns[i]![r]])))
    },
  }
  const recording = await readLmuTables(reader, options)
  return { manifest, recording }
}

function parseManifest(entries: Map<string, Uint8Array>): LmuBundleManifest {
  const raw = entries.get(MANIFEST)
  if (!raw) throw new LmuBundleError("Not an LMU bundle: manifest.json is missing.")
  let manifest: LmuBundleManifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new LmuBundleError("Not an LMU bundle: manifest.json is not valid JSON.")
  }
  if (manifest?.format !== LMU_BUNDLE_FORMAT) throw new LmuBundleError("Not an LMU bundle: unknown format.")
  if (manifest.version !== LMU_BUNDLE_VERSION) {
    throw new LmuBundleError(`Unsupported LMU bundle version ${manifest.version} (this reader handles ${LMU_BUNDLE_VERSION}).`)
  }
  if (!Array.isArray(manifest.tables) || typeof manifest.source?.sha256 !== "string") {
    throw new LmuBundleError("Not an LMU bundle: the manifest is incomplete.")
  }
  return manifest
}

/** Decode a Parquet file column by column; numeric columns stay typed arrays. */
async function readParquetColumns(data: Uint8Array): Promise<{ columnNames: string[]; columns: ArrayLike<unknown>[] }> {
  const file = asyncBuffer(data)
  const metadata = parquetMetadata(await file.slice(0, data.byteLength))
  const rows = Number(metadata.num_rows)
  const columnNames = metadata.schema.slice(1).map((s) => s.name)
  const chunks = new Map<string, Array<{ rowStart: number; data: ArrayLike<unknown> }>>()
  await parquetRead({
    file,
    metadata,
    onChunk: ({ columnName, columnData, rowStart }) => {
      const list = chunks.get(columnName) ?? []
      list.push({ rowStart, data: columnData })
      chunks.set(columnName, list)
    },
  })
  const columns = columnNames.map((name) => joinChunks(chunks.get(name) ?? [], rows))
  return { columnNames, columns }
}

function joinChunks(chunks: Array<{ rowStart: number; data: ArrayLike<unknown> }>, rows: number): ArrayLike<unknown> {
  if (chunks.length === 1 && chunks[0]!.rowStart === 0 && chunks[0]!.data.length === rows) return chunks[0]!.data
  const first = chunks[0]?.data
  if (first instanceof Float32Array || first instanceof Float64Array) {
    const out = first instanceof Float32Array ? new Float32Array(rows) : new Float64Array(rows)
    for (const c of chunks) out.set(c.data as ArrayLike<number>, c.rowStart)
    return out
  }
  const out: unknown[] = new Array(rows)
  for (const c of chunks) for (let i = 0; i < c.data.length; i++) out[c.rowStart + i] = c.data[i]
  return out
}

/** hyparquet reads through `slice`; only the requested ranges are copied. */
function asyncBuffer(data: Uint8Array): AsyncBuffer {
  return {
    byteLength: data.byteLength,
    slice: (start: number, end?: number) =>
      data.buffer.slice(data.byteOffset + start, data.byteOffset + (end ?? data.byteLength)) as ArrayBuffer,
  }
}

/**
 * Entries of a store-only zip as views into `bytes` (no copies). Bundles are
 * written uncompressed, so anything else is rejected rather than inflated.
 */
function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new LmuBundleError("Not an LMU bundle: not a zip file.")
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const entries = new Map<string, Uint8Array>()
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) {
      throw new LmuBundleError("Corrupt LMU bundle: bad zip directory.")
    }
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen))
    if (method !== 0 || compressed !== size) throw new LmuBundleError(`Corrupt LMU bundle: "${name}" is compressed.`)
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) {
      throw new LmuBundleError(`Corrupt LMU bundle: bad header for "${name}".`)
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (start + size > bytes.byteLength) throw new LmuBundleError(`Corrupt LMU bundle: "${name}" is truncated.`)
    entries.set(name, bytes.subarray(start, start + size))
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}
