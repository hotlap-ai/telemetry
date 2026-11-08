/**
 * Le Mans Ultimate telemetry (`.duckdb` recordings, LMU >= 1.2).
 *
 * Runtime-neutral: no DuckDB and no file I/O here. The host opens the
 * recording with its own DuckDB and passes an `LmuTableSource` to
 * `readLmuTables`; `normalizeLmuRecording` turns the tables into laps.
 */
export * from "./lmu/normalize"
export * from "./lmu/reader"
