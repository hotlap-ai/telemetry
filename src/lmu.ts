/**
 * Le Mans Ultimate telemetry (`.duckdb` recordings, LMU >= 1.2).
 *
 * Runtime-neutral: no DuckDB and no file I/O here. The host opens the
 * recording with its own DuckDB and passes an `LmuTableSource` to
 * `readLmuTables`; `normalizeLmuRecording` turns the tables into laps.
 * `packLmuBundle` / `readLmuBundle` carry those tables to hosts without
 * DuckDB (the server) as Parquet in a zip.
 */
export * from "./lmu/normalize"
export * from "./lmu/reader"
export * from "./lmu/bundle"
