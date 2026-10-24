// REASON CODES — keep the documented taxonomy and the emitted strings in sync.
//
// `REASON_CODES` is exported from planner.js and imported by NOTHING: not the
// CLI, not the server, not a test. `reasonCodeFor` returns bare string
// literals. So the map that documents what each code means, and the branches
// that actually emit them, can drift apart silently — rename a branch's
// literal and the map still claims the old name exists, with nothing failing.
//
// The guide publishes this taxonomy to a beta team, so drift is a documented
// lie waiting to happen rather than a style problem.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REASON_CODES } from '../src/planner.js'

const SRC = readFileSync(fileURLToPath(new URL('../src/planner.js', import.meta.url)), 'utf8')

/** Every bare code string the planner can actually produce. */
function emittedCodes() {
  const codes = new Set()
  // `return 'CODE'` inside reasonCodeFor, and `reasonCodes: ['CODE']` elsewhere.
  for (const m of SRC.matchAll(/return '([A-Z_]{4,})'/g)) codes.add(m[1])
  for (const m of SRC.matchAll(/reasonCodes: \['([A-Z_]{4,})'\]/g)) codes.add(m[1])
  return codes
}

test('every code the planner emits is documented in REASON_CODES', () => {
  const undocumented = [...emittedCodes()].filter((c) => !(c in REASON_CODES))
  assert.deepEqual(undocumented, [],
    `emitted but undocumented — the guide publishes this map: ${undocumented.join(', ')}`)
})

test('every documented code is one the planner can emit', () => {
  const emitted = emittedCodes()
  const phantom = Object.keys(REASON_CODES).filter((c) => !emitted.has(c))
  assert.deepEqual(phantom, [],
    `documented but never emitted anywhere in planner.js: ${phantom.join(', ')}`)
})

test('every documented code explains itself in a sentence a student can read', () => {
  for (const [code, text] of Object.entries(REASON_CODES)) {
    assert.equal(typeof text, 'string', `${code} has no description`)
    assert.ok(text.length > 20, `${code}: "${text}" is too terse to help anyone`)
    assert.ok(text === text.toLowerCase() || /[a-z]/.test(text[0]),
      `${code} should read as a sentence fragment, not a shout`)
  }
})

// CALIBRATION_STALE is emitted by a real branch, but no SHIPPED rule pack can
// currently reach it: every edge into a calibration originates at a physical
// component, those only change by human report, and PHYSICAL_CHANGE_REPORTED
// outranks it. That is a documentation hazard, not a bug — the output is
// correct either way — so the guide must not list it among codes "in use".
test('the guide does not claim an unreachable code is in use', (t) => {
  // docs/ is development-repo only; the published artifact ships README and
  // START_HERE and nothing else. Absent guide = nothing to guard, not a fail.
  const guidePath = fileURLToPath(new URL('../../docs/Nexum-Technical-Guide.md', import.meta.url))
  if (!existsSync(guidePath)) {
    return t.skip('docs/ is not part of the published artifact — this guard is repo-only')
  }
  const guide = readFileSync(guidePath, 'utf8')
  if (!guide.includes('CALIBRATION_STALE')) return  // nothing to guard
  const idx = guide.indexOf('CALIBRATION_STALE')
  const context = guide.slice(Math.max(0, idx - 1200), idx + 1200)
  assert.ok(/not currently reachable|no shipped rule pack|outranked|defined but/i.test(context),
    'CALIBRATION_STALE is listed without noting that shipped packs cannot currently produce it')
})
