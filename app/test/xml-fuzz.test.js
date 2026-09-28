// Config-XML mutation fuzz through the WHOLE engine pipeline — 24,000 seeded
// mutations of structurally valid FTC configs, each pushed through
// parseConfigXml → reconcile → verdict. The contract:
//   parse either returns a model or throws an Error with a string message;
//   a returned model NEVER crashes reconcile;
//   reconcile only ever emits registered checks with legal severities;
//   verdict is exactly PASS or FAIL.
// This is the pipeline a student feeds a hand-edited, half-saved, editor-
// mangled XML into at 7:58am in a pit. Whatever the file looks like, the
// tool's answer is a verdict or a named error — never a stack trace, never
// silence, and never a finding the registry has never heard of.
//
// (The 900-seed fuzz.test.js corpus attacks the parser's value handling;
// this one attacks STRUCTURE — truncation, splicing, duplication, entity
// garbage, tag surgery — at 9× the scale, then drives the full engine.)

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigXml, toSnapshot } from '../src/configXml.js'
import { reconcile, diffSnapshot, verdict } from '../src/engine.js'
import { CHECKS } from '../src/registry.js'
import { mulberry32, genConfigXml, int, pick } from './helpers/gen.js'

const KNOWN = new Set(CHECKS.map((c) => c.id))
const SEVERITIES = new Set(['FAIL', 'WARN', 'INFO'])

const MUTATORS = [
  { kind: 'truncate', apply: (xml, rnd) => xml.slice(0, int(rnd, 0, xml.length - 1)) },
  { kind: 'behead', apply: (xml, rnd) => xml.slice(int(rnd, 1, Math.min(80, xml.length - 1))) },
  {
    kind: 'splice-out',
    apply: (xml, rnd) => {
      const start = int(rnd, 0, xml.length - 2)
      return xml.slice(0, start) + xml.slice(int(rnd, start + 1, xml.length - 1))
    },
  },
  {
    kind: 'duplicate-slice',
    apply: (xml, rnd) => {
      const start = int(rnd, 0, xml.length - 2)
      const end = int(rnd, start + 1, Math.min(start + 120, xml.length - 1))
      return xml.slice(0, end) + xml.slice(start, end) + xml.slice(end)
    },
  },
  {
    kind: 'inject-metachars',
    apply: (xml, rnd) => {
      const at = int(rnd, 0, xml.length - 1)
      return xml.slice(0, at) + pick(rnd, ['<', '>', '&', '"', "'", '<!--', '-->', '<![CDATA[', ']]>', '&#lt;', '&&amp;;']) + xml.slice(at)
    },
  },
  {
    kind: 'flip-char',
    apply: (xml, rnd) => {
      const at = int(rnd, 0, xml.length - 1)
      const c = xml[at] === 'z' ? 'q' : 'z'
      return xml.slice(0, at) + c + xml.slice(at + 1)
    },
  },
  {
    kind: 'attribute-surgery',
    apply: (xml, rnd) => pick(rnd, [
      () => xml.replace(/port="\d+"/, `port="${pick(rnd, ['-1', '99', 'NaN', '', 'seven', '0x03', '3.5'])}"`),
      () => xml.replace(/name="[^"]*"/, `name="${pick(rnd, ['', ' ', 'a"b', '&amp;&lt;&gt;', 'x'.repeat(300)])}"`),
      () => xml.replace(/parentModuleAddress="\d+"/, `parentModuleAddress="${pick(rnd, ['0', '999', 'two', ''])}"`),
      () => xml.replace(/port="173"/, 'port=""'),
    ])(),
  },
  {
    kind: 'tag-surgery',
    apply: (xml, rnd) => pick(rnd, [
      () => xml.replace('</LynxModule>', ''),
      () => xml.replace('<LynxModule', '<LynxModule><LynxModule'),
      () => xml.replace(/<Robot [^>]*>/, '<Robot>'),
      () => xml.replace(/<Robot [^>]*>/, ''),
      () => xml + '<Motor name="after_the_end" port="0" />',
    ])(),
  },
  { kind: 'double-mutation', apply: (xml, rnd) => MUTATORS[int(rnd, 0, 7)].apply(MUTATORS[int(rnd, 0, 7)].apply(xml, rnd), rnd) },
]

for (let seed = 1; seed <= 24000; seed++) {
  const rnd = mulberry32(seed * 71)
  const mutator = MUTATORS[seed % MUTATORS.length]
  test(`xml-fuzz seed ${seed} [${mutator.kind}]: parse→reconcile→verdict never crashes, never invents checks`, () => {
    const original = genConfigXml(rnd)
    const mangled = mutator.apply(original, rnd)

    let model
    try {
      model = parseConfigXml(mangled)
    } catch (e) {
      assert.ok(e instanceof Error && typeof e.message === 'string', 'parse rejection must be a clean Error')
      return
    }

    assert.ok(Array.isArray(model.devices), 'a returned model must have a devices array')
    assert.ok(Array.isArray(model.unparsed), 'and an unparsed array — ambiguity is surfaced, not dropped')

    const findings = reconcile(model, { refs: [], dynamic: [], filesScanned: 0 })
    for (const f of findings) {
      assert.ok(KNOWN.has(f.checkId), `unregistered check "${f.checkId}" escaped the engine`)
      assert.ok(SEVERITIES.has(f.severity), `illegal severity "${f.severity}"`)
      assert.equal(typeof f.message, 'string')
      assert.ok(Array.isArray(f.evidence))
      assert.equal(typeof f.fix, 'string')
    }
    assert.ok(['PASS', 'FAIL'].includes(verdict(findings)), 'the verdict is binary, whatever the input looked like')

    // And the snapshot path: a parseable mangled config must also survive
    // diffing against its own snapshot (zero-delta) and against the original.
    const snap = toSnapshot(model)
    assert.deepEqual(diffSnapshot(snap, snap).filter((f) => f.severity === 'FAIL'), [], 'a config never drifts from itself')
    let originalModel
    try {
      originalModel = parseConfigXml(original)
    } catch {
      return
    }
    const drift = diffSnapshot(toSnapshot(originalModel), snap)
    for (const f of drift) assert.ok(KNOWN.has(f.checkId))
  })
}
