import { describe, expect, test } from "bun:test"
import { LMU_CHANNELS_USED, LMU_EVENTS_USED, ident, normalizeLmuRecording, readLmuTables, type LmuTableSource } from "../src/lmu"
import { buildSyntheticSession } from "./fixtures/lmu-session"

interface FakeTable {
  columnNames: string[]
  columns: unknown[][]
}

/**
 * An in-memory stand-in for a DuckDB connection over an LMU file: answers the
 * index queries and `SELECT * FROM "<table>"`, and records every query so
 * tests can check that unwanted tables are never read.
 */
function fakeSource(opts: {
  metadata?: Record<string, unknown>
  channelsList?: Array<{ channelName: string; frequency: unknown; unit: unknown }>
  eventsList?: Array<{ eventName: string; unit: unknown }>
  tables: Record<string, FakeTable>
}): LmuTableSource & { queries: string[] } {
  const queries: string[] = []
  const names = new Set(Object.keys(opts.tables))
  if (opts.metadata) names.add("metadata")
  if (opts.channelsList) names.add("channelsList")
  if (opts.eventsList) names.add("eventsList")
  return {
    queries,
    async queryRows(sql) {
      queries.push(sql)
      if (sql.includes("duckdb_tables()")) return [...names].map((table_name) => ({ table_name }))
      if (sql.includes("FROM metadata")) return Object.entries(opts.metadata ?? {}).map(([key, value]) => ({ key, value }))
      if (sql.includes('"channelsList"')) return opts.channelsList ?? []
      if (sql.includes('"eventsList"')) return opts.eventsList ?? []
      throw new Error(`unexpected query: ${sql}`)
    },
    async readColumns(sql) {
      queries.push(sql)
      const name = Object.keys(opts.tables).find((n) => sql === `SELECT * FROM ${ident(n)}`)
      if (!name) throw new Error(`unexpected table read: ${sql}`)
      return opts.tables[name]!
    },
  }
}

function sourceFor(recording: ReturnType<typeof buildSyntheticSession>["recording"]) {
  const tables: Record<string, FakeTable> = {}
  for (const [name, c] of Object.entries(recording.channels)) tables[name] = { columnNames: c.columnNames, columns: c.columns }
  for (const [name, e] of Object.entries(recording.events)) {
    tables[name] = { columnNames: ["ts", "value"], columns: [e.rows.map((r) => r[0]), e.rows.map((r) => r[1])] }
  }
  return fakeSource({
    metadata: recording.metadata,
    channelsList: Object.entries(recording.channels).map(([channelName, c]) => ({ channelName, frequency: c.frequency, unit: c.unit })),
    eventsList: Object.entries(recording.events).map(([eventName, e]) => ({ eventName, unit: e.unit })),
    tables,
  })
}

describe("readLmuTables", () => {
  const session = buildSyntheticSession()

  test("round-trips a recording through the index tables", async () => {
    const read = await readLmuTables(sourceFor(session.recording))
    expect(read.missingTables).toEqual([])
    expect(read.metadata).toEqual(session.recording.metadata)
    expect(read.channels).toEqual(session.recording.channels)
    expect(read.events).toEqual(session.recording.events)
  })

  test("the tables it reads normalize to the same laps as the source", async () => {
    const read = await readLmuTables(sourceFor(session.recording), { channels: LMU_CHANNELS_USED, events: LMU_EVENTS_USED })
    const viaReader = normalizeLmuRecording(read)
    const direct = normalizeLmuRecording(session.recording)
    expect(viaReader.laps.map((l) => l.lapTimeSec)).toEqual(direct.laps.map((l) => l.lapTimeSec))
    expect(viaReader.session).toEqual(direct.session)
  })

  test("only reads the requested tables", async () => {
    const source = sourceFor(session.recording)
    const read = await readLmuTables(source, { channels: ["GPS Time"], events: ["Lap"] })
    expect(Object.keys(read.channels)).toEqual(["GPS Time"])
    expect(Object.keys(read.events)).toEqual(["Lap"])
    const tableReads = source.queries.filter((q) => q.startsWith("SELECT * FROM"))
    expect(tableReads).toEqual([`SELECT * FROM ${ident("GPS Time")}`, `SELECT * FROM ${ident("Lap")}`])
  })

  test("lists index entries that have no table instead of failing", async () => {
    const read = await readLmuTables(
      fakeSource({
        channelsList: [{ channelName: "Ghost Channel", frequency: 10, unit: "" }],
        eventsList: [{ eventName: "Ghost Event", unit: "" }],
        tables: {},
      }),
    )
    expect(read.missingTables).toEqual(["Ghost Channel", "Ghost Event"])
    expect(read.channels).toEqual({})
    expect(read.events).toEqual({})
  })

  test("a file without index tables reads as empty", async () => {
    const read = await readLmuTables(fakeSource({ tables: {} }))
    expect(read).toEqual({ metadata: {}, channels: {}, events: {}, missingTables: [] })
  })

  test("coerces DuckDB value types", async () => {
    const read = await readLmuTables(
      fakeSource({
        metadata: { TrackName: "Sebring", Laps: 12n, Missing: null },
        channelsList: [{ channelName: "Engine RPM", frequency: 50n, unit: null }],
        eventsList: [
          { eventName: "Gear", unit: "" },
          { eventName: "In Pits", unit: "" },
        ],
        tables: {
          "Engine RPM": { columnNames: ["value"], columns: [[7000, 7100n, "7200", true, null]] },
          Gear: { columnNames: ["ts", "value"], columns: [[1n, 2.5], [3n, "N"]] },
          // Some event tables name their value column differently.
          "In Pits": { columnNames: ["ts", "inPits"], columns: [[10], [true]] },
        },
      }),
    )
    expect(read.metadata).toEqual({ TrackName: "Sebring", Laps: "12", Missing: "" })
    expect(read.channels["Engine RPM"]!.frequency).toBe(50)
    expect(read.channels["Engine RPM"]!.unit).toBe("")
    expect(read.channels["Engine RPM"]!.columns[0]!.slice(0, 4)).toEqual([7000, 7100, 7200, 1])
    expect(read.channels["Engine RPM"]!.columns[0]![4]).toBeNaN()
    expect(read.events.Gear!.rows).toEqual([
      [1, 3],
      [2.5, "N"],
    ])
    expect(read.events["In Pits"]!.rows).toEqual([[10, 1]])
  })

  test("quotes table names with spaces and quotes", () => {
    expect(ident("GPS Time")).toBe('"GPS Time"')
    expect(ident('a"b')).toBe('"a""b"')
  })
})
