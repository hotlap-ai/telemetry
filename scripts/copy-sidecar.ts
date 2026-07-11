/**
 * Copies the compiled telemetry server into the Tauri app's sidecar binaries
 * directory using the target-triple name Tauri expects. Run via
 * `bun run build:sidecar` after changing telemetry-server.ts — the app bundles
 * whatever binary sits in UI/src-tauri/binaries, and a stale one silently
 * ships old behavior.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const exeSuffix = process.platform === 'win32' ? '.exe' : ''

const targetTriple = {
  win32: 'x86_64-pc-windows-msvc',
  darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
  linux: 'x86_64-unknown-linux-gnu',
}[process.platform as 'win32' | 'darwin' | 'linux']

if (!targetTriple) {
  console.error(`Unsupported platform: ${process.platform}`)
  process.exit(1)
}

const root = dirname(import.meta.dir) // TELEMETRY/
const source = join(root, 'dist', `hotlap-telemetry${exeSuffix}`)
const destDir = join(dirname(root), 'hotlap.ai', 'UI', 'src-tauri', 'binaries')
const dest = join(destDir, `hotlap-telemetry-${targetTriple}${exeSuffix}`)

if (!existsSync(source)) {
  console.error(`Compiled server not found at ${source} — run build:server first.`)
  process.exit(1)
}

await mkdir(destDir, { recursive: true })
await copyFile(source, dest)
console.log(`Sidecar copied to ${dest}`)
