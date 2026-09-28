// The core/adapter boundary, as an executable law instead of a hope.
//
// PHYSYNC's long-term shape: platform adapters (FTC today; anything with
// physical state someday) produce observations; a platform-independent core
// reasons about states, changes, dependencies, evidence, and revalidation.
// Today that separation exists de facto — this test makes it de jure, so the
// day someone imports the FTC XML parser into the planner, a test fails with
// this file's name on it instead of the coupling fossilizing silently.
//
// The rule is one-directional on purpose: adapters may import the core
// (approval.js re-exports firmware normalization, bin/server wire everything
// together); the core may never import an adapter.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname

// The platform-independent core: states, change detection, the dependency
// graph, the planner, results, human reports, rule-pack data, and the
// firmware-normalization boundary module.
const CORE = ['state.js', 'planner.js', 'graph.js', 'results.js', 'reported.js', 'packs.js', 'firmware.js', 'inventory.js', 'fingerprints.js', 'text.js']

// FTC-specific (or FTC-product-specific) modules: parsers of FTC artifacts,
// the reconciliation engine over them, the approval/gate wire format, and
// the delivery layer.
const ADAPTER = ['configXml.js', 'codeScan.js', 'sensors.js', 'stimulus.js', 'engine.js', 'approval.js', 'report.js', 'registry.js', 'server.js', 'assist.js']

const localImports = (file) =>
  [...readFileSync(join(SRC, file), 'utf8').matchAll(/^import\s.*?from\s+'\.\/([^']+)'/gm)].map((m) => m[1])

test('every src module is classified — a new module must pick a side', () => {
  const all = readdirSync(SRC).filter((f) => f.endsWith('.js'))
  const known = new Set([...CORE, ...ADAPTER])
  const unclassified = all.filter((f) => !known.has(f))
  assert.deepEqual(unclassified, [], `unclassified module(s): ${unclassified.join(', ')} — add to CORE or ADAPTER in this test, consciously`)
})

test('no core module imports an adapter module — the engine stays platform-independent', () => {
  const violations = []
  for (const file of CORE) {
    for (const dep of localImports(file)) {
      if (ADAPTER.includes(dep)) violations.push(`${file} → ${dep}`)
    }
  }
  assert.deepEqual(violations, [], `core→adapter import(s): ${violations.join('; ')} — move the shared piece to a boundary module (see firmware.js) or pass the data in`)
})

test('core modules import only the core (and node builtins)', () => {
  for (const file of CORE) {
    for (const dep of localImports(file)) {
      assert.ok(CORE.includes(dep), `${file} imports ${dep}, which is not a core module`)
    }
  }
})
