#!/usr/bin/env node
// Pack the agent into the tarball the fleet installs.
//
// Usage:
//   node scripts/package-agent.mjs [output-dir]
//
// The archive is **byte-reproducible**: every entry carries a fixed timestamp,
// a fixed owner and fixed permissions rather than whatever the packing machine
// happened to have, and the entries are sorted. That is the whole point. The
// module compiles a sha256 into `main/agent/manifest.ts`, every target machine
// checks the download against it before unpacking, and a hash that could only
// come from one particular run on one particular machine would be worthless as
// a promise about the source.
//
// The tar writer is hand-rolled for the same reason the zip writer next door
// is: Node ships no tar, and shelling out to the system `tar` would make the
// bytes depend on which implementation is installed.
//
// Shape: a single top-level folder `boredagent-<version>/` holding the package,
// its requirements, its unit file, its example config and `install/`. That is
// what `agent-install.sh` expects to find itself inside, and what
// `main/agent/lifecycle.ts` looks for with `find -name agent-install.sh`.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import { dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const agentDir = join(repoRoot, 'agent')

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

if (!existsSync(join(agentDir, 'boredagent'))) fail(`no agent package at ${agentDir}`)

/** The version is the agent's own, from pyproject.toml - one source of truth. */
function agentVersion() {
  const raw = readFileSync(join(agentDir, 'pyproject.toml'), 'utf8')
  const match = /^version\s*=\s*"([^"]+)"/m.exec(raw)
  if (!match) fail('agent/pyproject.toml has no version')
  if (!/^\d+\.\d+\.\d+$/.test(match[1])) fail(`agent version "${match[1]}" is not x.y.z`)
  return match[1]
}

/**
 * What goes in. Named rather than globbed from the folder: a tarball that
 * silently grew whatever happened to be lying in the working tree - a venv, a
 * .pytest_cache, somebody's notes - is how a 200 KB archive becomes 80 MB, and
 * how something nobody meant to publish gets published.
 */
const INCLUDE_DIRS = ['boredagent', 'config', 'systemd', 'install']
const INCLUDE_FILES = ['pyproject.toml', 'requirements.txt', 'README.md', 'SPEC.md']

/** Never packed, whatever a directory above says. */
const EXCLUDE_DIRS = new Set(['__pycache__', '.pytest_cache', 'venv', '.venv', 'tests', '.git'])

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      out.push(...listFiles(full, base))
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.pyc')) continue
    out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

const version = agentVersion()
const root = `boredagent-${version}`

const members = []
for (const name of INCLUDE_FILES) {
  const path = join(agentDir, name)
  if (existsSync(path)) members.push(name)
}
for (const name of INCLUDE_DIRS) {
  const path = join(agentDir, name)
  if (!existsSync(path)) fail(`agent/${name} is missing`)
  for (const rel of listFiles(path, agentDir)) members.push(rel)
}
members.sort()

if (!members.includes('install/agent-install.sh')) {
  fail('install/agent-install.sh is not in the archive - nothing could install it')
}
if (!members.includes('systemd/boredagent.service')) {
  fail('systemd/boredagent.service is not in the archive')
}
if (!members.includes('requirements.txt')) fail('requirements.txt is not in the archive')

/**
 * 2020-01-01 00:00:00 UTC, in seconds. A constant rather than the clock, and a
 * constant rather than "now rounded", so the timezone of the packing machine
 * cannot move it either.
 */
const FIXED_MTIME = 1577836800

/** Owned by nobody in particular; the installer sets what it needs on the target. */
const FIXED_UID = 0
const FIXED_GID = 0

/** Executable for the two shell scripts, read-only otherwise. */
function modeFor(name) {
  return name.endsWith('.sh') ? 0o755 : 0o644
}

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

/** One 512-byte ustar header, checksummed the way the format requires. */
function header(name, size, mode) {
  const buffer = Buffer.alloc(512, 0)
  const path = Buffer.from(name, 'utf8')
  if (path.length > 100) {
    // Every path here is short; a longer one would need a PAX extension and
    // silently truncating would produce an archive that unpacks wrongly.
    fail(`path too long for a ustar header: ${name}`)
  }
  buffer.write(name, 0, 'utf8')
  buffer.write(octal(mode, 8), 100, 'ascii')
  buffer.write(octal(FIXED_UID, 8), 108, 'ascii')
  buffer.write(octal(FIXED_GID, 8), 116, 'ascii')
  buffer.write(octal(size, 12), 124, 'ascii')
  buffer.write(octal(FIXED_MTIME, 12), 136, 'ascii')
  // The checksum field is spaces while the checksum is computed over it.
  buffer.write('        ', 148, 'ascii')
  buffer.write('0', 156, 'ascii') // regular file
  buffer.write('ustar\0', 257, 'ascii')
  buffer.write('00', 263, 'ascii')

  let sum = 0
  for (const byte of buffer) sum += byte
  buffer.write(octal(sum, 7), 148, 'ascii')
  buffer.write(' ', 154, 'ascii')
  return buffer
}

const chunks = []
let totalBytes = 0
for (const rel of members) {
  const data = readFileSync(join(agentDir, rel))
  const name = `${root}/${rel}`
  chunks.push(header(name, data.length, modeFor(rel)))
  chunks.push(data)
  const padding = (512 - (data.length % 512)) % 512
  if (padding) chunks.push(Buffer.alloc(padding, 0))
  totalBytes += data.length
}
// Two empty blocks end a tar, and a little trailing zero padding is customary.
chunks.push(Buffer.alloc(1024, 0))

const tar = Buffer.concat(chunks)
// `mtime: 0` keeps the gzip header itself out of the reproducibility problem -
// without it the archive carries the packing time and no two packs match.
const gz = gzipSync(tar, { level: 9, mtime: 0 })

const outputDir = resolve(process.argv[2] ?? join(repoRoot, 'dist'))
mkdirSync(outputDir, { recursive: true })
const tarName = `boredagent-${version}.tar.gz`
const tarPath = join(outputDir, tarName)
writeFileSync(tarPath, gz)

const sha256 = createHash('sha256').update(gz).digest('hex')
writeFileSync(join(outputDir, `${tarName}.sha256`), `${sha256}  ${tarName}\n`)

console.log(`\n==> ${tarPath}`)
console.log(`    BoredAgent ${version} - ${members.length} files, ${(gz.length / 1024).toFixed(1)} KB`)
console.log(`    sha256 ${sha256}`)
console.log(`
    Put that sha256 into AGENT_SHA256 in
    service-fleet/main/agent/manifest.ts before releasing the module, and
    attach this tarball to the agent-v${version} release.`)
