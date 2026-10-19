// DISTRIBUTION — locks the `npx` install path.
//
// A real test found that the README's very first command ("prove it runs in 60
// seconds") failed with ENOENT under npx: it pointed at `app/samples/config.xml`,
// a path that exists in a git clone and nowhere in an installed package. A team
// whose first command errors does not reach a second one, so this is a beta-
// blocking defect even though the engine was perfectly fine.
//
// These tests assert the properties that make `npx nexum-beta` work, each of
// which was broken or absent before:
//   1. `demo` resolves its sample robot from the PACKAGE, not the cwd
//   2. the package is publishable at all (`private: true` blocks npm publish)
//   3. the install stays dependency-free (the AI SDK is 17 MB of optional)
//   4. every path the tarball ships is actually present

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(APP, 'bin/physync.js')
const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))

test('`demo` works from a cwd with no samples — the npx reality', () => {
  // An empty temp dir stands in for the team's own robot folder, which under
  // npx is the cwd and never contains samples/.
  const elsewhere = mkdtempSync(join(tmpdir(), 'nexum-npx-'))
  const r = spawnSync(process.execPath, [CLI, 'demo'], { cwd: elsewhere, encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  assert.ok(!/ENOENT|Cannot read config/.test(out), `demo must not depend on cwd:\n${out}`)
  assert.match(out, /NEXUM PREFLIGHT/, 'it ran the real preflight')
  assert.match(out, /MEANT to fail/, 'and tells them the sample failure is expected, not their mistake')
  assert.match(out, /physync init/, 'and names the next step')
  assert.equal(r.status, 0, 'demo exits 0 — it proves the tool runs; the SAMPLE failing is the point')
})

test('demo and check agree — demo is the same engine, not a special path', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'nexum-npx-'))
  const demo = spawnSync(process.execPath, [CLI, 'demo'], { cwd: elsewhere, encoding: 'utf8' }).stdout
  const check = spawnSync(process.execPath, [CLI, 'check', '--config', 'samples/config.xml', '--code', 'samples/TeamCode'],
    { cwd: APP, encoding: 'utf8' }).stdout
  // Same findings, same counts — demo only adds trailing guidance lines.
  const findings = (s) => (s.match(/^\s*[✗!·]\s+\S/gm) ?? []).length
  assert.ok(findings(check) > 0, 'the sample robot has findings to report')
  assert.equal(findings(demo), findings(check), 'demo reports exactly what check reports')
})

test('the package can actually be published', () => {
  assert.ok(!pkg.private, '`private: true` makes `npm publish` refuse — it must be gone')
  assert.ok(pkg.files?.length, 'without a files allowlist the tarball ships 33 test shards')
  assert.equal(pkg.bin.nexum, 'bin/physync.js', 'the command teams were told to run is `nexum`')
  assert.ok(pkg.bin.physync, 'and the original name keeps working for existing scripts')
})

test('a default install downloads NO dependencies — the offline promise, enforced', () => {
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'the beta loop is offline and zero-dependency; a hard dep makes npx download 17 MB on school wifi')
  assert.equal(pkg.peerDependenciesMeta?.['@anthropic-ai/sdk']?.optional, true,
    'the AI SDK must be an OPTIONAL peer, or npm auto-installs it anyway')
})

// The npm package page renders the PACKAGED README. A stale copy lived at
// app/README.md from the PHYSYNC era: it named the wrong product five times
// and linked to ../SPEC.md and ../ecosystems.md, internal files the tarball
// does not ship — so the first page a beta team saw would have shown another
// product's name and three dead links. The root files are now the single
// source of truth, copied in by `prepack`.
test('the packaged docs are generated from the root, and name the right product', () => {
  const r = spawnSync('npm', ['run', 'prepack'], { cwd: APP, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(r.status, 0, `prepack failed:\n${r.stdout}${r.stderr}`)
  for (const doc of ['README.md', 'START_HERE.md']) {
    const packaged = readFileSync(join(APP, doc), 'utf8')
    const root = readFileSync(join(APP, '..', doc), 'utf8')
    assert.equal(packaged, root, `${doc} in the package must be byte-identical to the root copy`)
    assert.ok(!/PHYSYNC/.test(packaged), `${doc} must not show a second product name to a beta team`)
    assert.match(packaged, /Nexum/, `${doc} names the product the team was given`)
    // Relative links out of the package resolve to nothing once installed.
    const escaping = [...packaged.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1])
    assert.deepEqual(escaping, [], `${doc} links outside the package: ${escaping.join(', ')}`)
  }
})

test('every path in the files allowlist exists, and the runtime ones are complete', () => {
  spawnSync('npm', ['run', 'prepack'], { cwd: APP, encoding: 'utf8', shell: process.platform === 'win32' })
  for (const f of pkg.files) {
    assert.ok(existsSync(join(APP, f)), `files[] names "${f}", which does not exist`)
  }
  // The engine, the CLI, demo's samples, and the local UI must all ship.
  for (const needed of ['bin/physync.js', 'src/state.js', 'samples/config.xml', 'samples/TeamCode', 'ui/index.html']) {
    assert.ok(pkg.files.some((f) => needed.startsWith(f.replace(/\/$/, '')) || f === needed),
      `${needed} is needed at runtime but no files[] entry covers it`)
  }
  // And the things that must NOT ship.
  assert.ok(!pkg.files.some((f) => /^(test|fixtures|robot|node_modules)\b/.test(f)),
    'tests, fixtures and local robot captures are not a team\'s business')
})

test('AI assist names an install command that works outside a clone', () => {
  const src = readFileSync(join(APP, 'src/assist.js'), 'utf8')
  assert.match(src, /npm install @anthropic-ai\/sdk/, 'an npx user has no physync/app to run `npm install` in')
})
