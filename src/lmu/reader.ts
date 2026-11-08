import type { LmuChannelData, LmuEventData, LmuRecordingData } from "./normalize"

/**
 * Reads the tables of a Le Mans Ultimate `.duckdb` recording through whatever
 * DuckDB the host has (the agent's native `@duckdb/node-api`, a WASM build on
 * a server). The host opens and closes the database; this module owns the
 * schema knowledge: the index tables, the per-channel and per-event tables,
 * and how their values are coerced.
 *
 * Schema (LMU >= 1.2):
 *  - `metadata(key, value)`: session-level strings (TrackName, CarName, ...).
 *  - `channelsList(channelName, frequency, unit)`: one table per channel,
 *    named after it, with no timestamp column (rows line up by frequency).
 *  - `eventsList(eventName, unit)`: one table per event with `ts` (session
 *    time, s) and `value` columns, written on change.
 * Names are always discovered from the index tables, never hard-coded.
 */
export interface LmuTableSource {
  /** Run a query and return its rows as plain objects. */
  queryRows(sql: string): Promise<Array<Record<string, unknown>>>
  /** Read a whole table: its column names and the values column by column. */
  readColumns(sql: string): Promise<{ columnNames: string[]; columns: unknown[][] }>
}

export interface LmuRecording extends LmuRecordingData {
  /** Names listed in channelsList/eventsList that have no table. */
  missingTables: string[]
}

export interface ReadLmuTablesOptions {
  /** Only load these channel tables (a full session has ~100, most unused). */
  channels?: readonly string[]
  /** Only load these event tables. */
  events?: readonly string[]
}

export async function readLmuTables(source: LmuTableSource, options: ReadLmuTablesOptions = {}): Promise<LmuRecording> {
  const wantedChannels = options.channels ? new Set(options.channels) : null
  const wantedEvents = options.events ? new Set(options.events) : null

  const tables = new Set(
    (await source.queryRows("SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main'")).map((r) => String(r.table_name)),
  )
  const missingTables: string[] = []

  const metadata: Record<string, string> = {}
  if (tables.has("metadata")) {
    for (const row of await source.queryRows("SELECT key, value FROM metadata")) metadata[String(row.key)] = text(row.value)
  }

  const channels: Record<string, LmuChannelData> = {}
  if (tables.has("channelsList")) {
    for (const row of await source.queryRows('SELECT channelName, frequency, unit FROM "channelsList"')) {
      const name = String(row.channelName)
      if (wantedChannels && !wantedChannels.has(name)) continue
      if (!tables.has(name)) {
        missingTables.push(name)
        continue
      }
      const table = await source.readColumns(`SELECT * FROM ${ident(name)}`)
      channels[name] = {
        frequency: num(row.frequency),
        unit: text(row.unit),
        columnNames: table.columnNames,
        columns: table.columns.map((col) => col.map(num)),
      }
    }
  }

  const events: Record<string, LmuEventData> = {}
  if (tables.has("eventsList")) {
    for (const row of await source.queryRows('SELECT eventName, unit FROM "eventsList"')) {
      const name = String(row.eventName)
      if (wantedEvents && !wantedEvents.has(name)) continue
      if (!tables.has(name)) {
        missingTables.push(name)
        continue
      }
      const table = await source.readColumns(`SELECT * FROM ${ident(name)}`)
      const cols = table.columnNames
      const tsAt = Math.max(0, cols.indexOf("ts"))
      const valueAt = cols.includes("value") ? cols.indexOf("value") : tsAt === 0 ? 1 : 0
      const tsCol = table.columns[tsAt] ?? []
      const valueCol = table.columns[valueAt] ?? []
      events[name] = {
        unit: text(row.unit),
        rows: tsCol.map((ts, i) => [num(ts), eventValue(valueCol[i])]),
      }
    }
  }

  return { metadata, channels, events, missingTables }
}

/** Quote a table name for SQL (names contain spaces, e.g. "GPS Time"). */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function num(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  if (typeof v === "boolean") return v ? 1 : 0
  if (typeof v === "string" && v.trim() !== "") return Number(v)
  return Number.NaN
}

function text(v: unknown): string {
  return v === null || v === undefined ? "" : String(v)
}

function eventValue(v: unknown): number | string {
  if (typeof v === "number" || typeof v === "string") return v
  if (typeof v === "bigint" || typeof v === "boolean") return num(v)
  return text(v)
}
