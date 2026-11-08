import { describe, expect, test } from "bun:test"
import { zipSync } from "fflate"
import {
  LMU_BUNDLE_FORMAT,
  LMU_BUNDLE_VERSION,
  LMU_CHANNELS_USED,
  LMU_EVENTS_USED,
  LmuBundleError,
  normalizeLmuRecording,
  packLmuBundle,
  readLmuBundle,
  readLmuBundleManifest,
  type LmuRecordingData,
} from "../src/lmu"
import { buildSyntheticSession } from "../src/lmu/testing"

const SOURCE = { fileName: "Autodromo Sintetico_P_2026-11-07T18_30_00Z.duckdb", sha256: "ab".repeat(32), sizeBytes: 6_800_000 }
const session = buildSyntheticSession()
const bundle = packLmuBundle(session.recording, SOURCE, { writer: "test" })

function plain(rec: LmuRecordingData) {
  return {
    metadata: rec.metadata,
    channels: Object.fromEntries(
      Object.entries(rec.channels).map(([k, c]) => [k, { ...c, columns: c.columns.map((col) => Array.from(col)) }]),
    ),
    events: rec.events,
  }
}

describe("packLmuBundle / readLmuBundle", () => {
  test("round-trips every table losslessly", async () => {
    const { manifest, recording } = await readLmuBundle(bundle)
    expect(manifest).toMatchObject({ format: LMU_BUNDLE_FORMAT, version: LMU_BUNDLE_VERSION, writer: "test", source: SOURCE })
    expect(recording.missingTables).toEqual([])
    // LMU writes FLOAT; the synthetic values are float64, so the bundle keeps them as DOUBLE.
    expect(plain(recording)).toEqual(plain(session.recording))
  })

  test("normalizes to exactly the same laps as the recording it came from", async () => {
    const { recording } = await readLmuBundle(bundle, { channels: LMU_CHANNELS_USED, events: LMU_EVENTS_USED })
    expect(normalizeLmuRecording(recording)).toEqual(normalizeLmuRecording(session.recording))
  })

  test("FLOAT data stays float32 and comes back as a Float32Array", async () => {
    const rec = structuredClone(session.recording)
    const rpm = rec.channels["Engine RPM"]!
    rpm.columns = rpm.columns.map((c) => Float32Array.from(c))
    const { recording } = await readLmuBundle(packLmuBundle(rec, SOURCE))
    const col = recording.channels["Engine RPM"]!.columns[0]!
    expect(col).toBeInstanceOf(Float32Array)
    expect(Array.from(col)).toEqual(Array.from(rpm.columns[0]!))
    // Session time needs double precision.
    expect(recording.channels["GPS Time"]!.columns[0]).toBeInstanceOf(Float64Array)
  })

  test("decodes only the requested tables", async () => {
    const { recording } = await readLmuBundle(bundle, { channels: ["GPS Time"], events: ["Lap"] })
    expect(Object.keys(recording.channels)).toEqual(["GPS Time"])
    expect(Object.keys(recording.events)).toEqual(["Lap"])
  })

  test("keeps string-valued events, NaN samples and empty tables", async () => {
    const rec = structuredClone(session.recording)
    rec.events.TyresCompound = { unit: "", rows: [[812.4, "Medium"], [900, "Soft"]] }
    rec.events["Yellow Flag State"] = { unit: "", rows: [] }
    rec.channels["Engine RPM"]!.columns[0]![5] = Number.NaN
    const { recording } = await readLmuBundle(packLmuBundle(rec, SOURCE))
    expect(recording.events.TyresCompound!.rows).toEqual([[812.4, "Medium"], [900, "Soft"]])
    expect(recording.events["Yellow Flag State"]!.rows).toEqual([])
    expect(recording.channels["Engine RPM"]!.columns[0]![5]).toBeNaN()
  })

  test("a recording without optional channels still packs and normalizes (with warnings)", async () => {
    const rec = structuredClone(session.recording)
    delete rec.channels["Engine RPM"]
    delete rec.channels.TyresPressure
    const { recording } = await readLmuBundle(packLmuBundle(rec, SOURCE))
    const out = normalizeLmuRecording(recording)
    expect(out.laps).toHaveLength(3)
    expect(out.warnings).toEqual(expect.arrayContaining(["Engine RPM", "TyresPressure"]))
  })

  test("is deterministic: the same recording packs to the same bytes", () => {
    expect(packLmuBundle(session.recording, SOURCE, { writer: "test" })).toEqual(bundle)
  })

  test("is much smaller than the recording", () => {
    // 3 timed laps (~5 min) of the 14 normalizer channels.
    expect(bundle.byteLength).toBeLessThan(1_500_000)
  })
})

describe("readLmuBundleManifest", () => {
  test("reads the manifest without decoding tables", () => {
    const manifest = readLmuBundleManifest(bundle)
    expect(manifest.source.sha256).toBe(SOURCE.sha256)
    expect(manifest.tables.map((t) => t.kind).slice(0, 3)).toEqual(["metadata", "channelsList", "eventsList"])
    expect(manifest.tables.filter((t) => t.kind === "channel")).toHaveLength(Object.keys(session.recording.channels).length)
  })

  test("rejects files that are not bundles", () => {
    expect(() => readLmuBundleManifest(new TextEncoder().encode("DUCK definitely not a zip"))).toThrow(LmuBundleError)
    const noManifest = zipSync({ "x.txt": new Uint8Array([1]) }, { level: 0 })
    expect(() => readLmuBundleManifest(noManifest)).toThrow(/manifest\.json is missing/)
  })

  test("rejects other formats and versions", () => {
    const manifest = (m: object) => zipSync({ "manifest.json": new TextEncoder().encode(JSON.stringify(m)) }, { level: 0 })
    expect(() => readLmuBundleManifest(manifest({ format: "other", version: 1 }))).toThrow(/unknown format/)
    expect(() => readLmuBundleManifest(manifest({ format: LMU_BUNDLE_FORMAT, version: 99 }))).toThrow(/Unsupported LMU bundle version 99/)
  })

  test("rejects compressed entries instead of inflating them", () => {
    const deflated = zipSync({ "manifest.json": new TextEncoder().encode("{}".repeat(100)) }, { level: 6 })
    expect(() => readLmuBundleManifest(deflated)).toThrow(/is compressed/)
  })
})
