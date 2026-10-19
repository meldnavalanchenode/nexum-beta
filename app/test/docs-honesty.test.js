// DOCS HONESTY — every command we tell a team to run must exist and work.
//
// Written because the Faraday prep found the README advertising
// `tests --define … --min 0.9` as the way to set a threshold, while that
// command refused any check `init` had already created. The engine was fine;
// the documented path dead-ended. That is the single most expensive failure
// mode for a remote beta — the team cannot ask a person standing next to them,
// so a doc that lies costs the whole cycle.
//
// These tests parse the actual docs and check every command against the real
// CLI. A command added to a doc but not to the product fails here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const APP = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(APP, 'bin/physync.js')
const DOCS = ['START_HERE.md', 'README.md'].filter((d) => existsSync(join(ROOT, d)))

const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' })
const usageText = (usage.stdout ?? '') + (usage.stderr ?? '')

/** Every command invocation in a doc's fenced bash blocks. */
function commandsIn(doc) {
  const text = readFileSync(join(ROOT, doc), 'utf8')
  const found = new Set()
  for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      // Both documented invocation forms: `npx nexum-beta <cmd>` (START_HERE)
      // and `node app/bin/physync.js <cmd>` (README / offline fallback).
      const m = line.match(/(?:npx\s+nexum(?:-beta)?|physync\.js)\s+([a-z-]+)/)
      if (m) found.add(m[1])
    }
  }
  return [...found]
}

test('docs exist where the export script expects them', () => {
  assert.ok(DOCS.includes('START_HERE.md'), 'START_HERE.md is the on-ramp a team is sent to')
  assert.ok(DOCS.includes('README.md'), 'README.md is the reference')
})

for (const doc of DOCS) {
  test(`every command in ${doc} is a real command`, () => {
    const cmds = commandsIn(doc)
    assert.ok(cmds.length >= 5, `expected real commands in ${doc}, found ${cmds.length}`)
    for (const c of cmds) {
      // An unknown command prints usage and exits non-zero; a real one does
      // not complain about the command itself.
      const r = spawnSync(process.execPath, [CLI, c], { cwd: APP, encoding: 'utf8' })
      const out = (r.stdout ?? '') + (r.stderr ?? '')
      assert.ok(!/^usage:/.test(out.trimStart()) || usageText.includes(` ${c} `) || usageText.includes(`\n  physync ${c}`),
        `${doc} documents "${c}" but the CLI does not implement it`)
      assert.ok(!new RegExp(`Unknown command .?${c}`).test(out), `${doc} documents a nonexistent command: ${c}`)
    }
  })
}

test('every flag the docs pass is accepted by the command it is passed to', () => {
  // The strict per-command flag allowlist in bin/physync.js rejects unknown
  // flags loudly. That is good — but it means a doc naming a flag that was
  // never registered produces an error instead of the promised behaviour.
  // This is exactly how `tests --threshold` shipped broken for one run.
  const offenders = []
  for (const doc of DOCS) {
    const text = readFileSync(join(ROOT, doc), 'utf8')
    for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
      for (const line of block[1].split('\n')) {
        const m = line.match(/(?:npx\s+nexum(?:-beta)?|physync\.js)\s+([a-z-]+)\s+(.*)$/)
        if (!m) continue
        const [, cmd, rest] = m
        for (const flag of rest.matchAll(/--([a-z-]+)/g)) {
          const r = spawnSync(process.execPath, [CLI, cmd, `--${flag[1]}`], { cwd: APP, encoding: 'utf8' })
          const out = (r.stdout ?? '') + (r.stderr ?? '')
          if (new RegExp(`Unknown flag "--${flag[1]}"`).test(out)) {
            offenders.push(`${doc}: \`${cmd} --${flag[1]}\` is rejected by the CLI`)
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `docs promise flags the CLI refuses:\n  ${offenders.join('\n  ')}`)
})

// START_HERE must not depend on anything that isn't live. `npx nexum-beta`
// requires the package to be PUBLISHED to npm — which requires an npm account
// nobody has. A doc whose first command resolves to "package not found" costs
// the whole beta cycle, so the on-ramp is the ZIP plus a plain `node` call:
// both work the moment the public repo is pushed, with no registry, no
// account, and no network after the download.
test('START_HERE depends on nothing unpublished — ZIP + node only', () => {
  const text = readFileSync(join(ROOT, 'START_HERE.md'), 'utf8')
  assert.match(text, /archive\/refs\/heads\/main\.zip/, 'the ZIP download is the on-ramp')
  assert.match(text, /node app\/bin\/physync\.js demo/, 'and `demo` is the first command, runnable from the ZIP')

  // No command block may invoke npx/npm — that would reintroduce the registry
  // dependency this doc exists to avoid.
  const bad = []
  for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      if (/^\s*(npx|npm)\s/.test(line)) bad.push(line.trim())
    }
  }
  assert.deepEqual(bad, [], `START_HERE must not require npm/npx:\n  ${bad.join('\n  ')}`)

  // Node is the one irreducible dependency, so it must be named with a version
  // floor and a link — not assumed.
  assert.match(text, /nodejs\.org/, 'Node is the only prerequisite and must be linked')
  assert.match(text, /20 or newer|20 or higher/, 'with the version floor stated')
})

test('the docs do not claim hardware verification Nexum has never done', () => {
  for (const doc of DOCS) {
    const text = readFileSync(join(ROOT, doc), 'utf8')
    assert.match(text, /never run on a real Control Hub/,
      `${doc} must state the hardware limitation — configuration is not physical verification`)
    assert.ok(!/\bguarantees\b|\bcertif(y|ied)\b|\bproves your robot\b/i.test(text),
      `${doc} overclaims — the strongest claim is VERIFIED FOR DEFINED CHECKS`)
  }
})
