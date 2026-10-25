// A NEWLY DECLARED DEVICE OWES EVIDENCE.
//
// The gap this closes: adding a device to the configuration produced
// `0 recheck(s) owed`. Not for cameras only — for a motor too. Adding hardware
// is the first thing a team does, and it was the first thing Nexum said nothing
// about.
//
// WHY IT SAID NOTHING. The per-device built-ins (`device:$n` →
// `motor-response:$n` and siblings) can only ever INVALIDATE evidence that
// already exists, because a brand-new device has none. So there was nothing to
// invalidate and no requirement to form.
//
// WHY THE RULE IS DETERMINISTIC rather than something a human must approve: it
// asserts a fact about the LEDGER, not a guess about the robot. A device entry
// that was not in the previous state has no recorded evidence attached to it.
// That is true by construction, which is the standard a built-in has to meet.
//
// TWO MISTAKES MADE WHILE BUILDING IT, both caught here:
//
//  1. The action was first `verify-device:<name>`, which no team could ever
//     discharge — assess.js only clears `test:` and `calibration:`
//     requirements from recorded results, so it would have been a permanent
//     demand. Permanent noise is worse than the silence it replaced.
//  2. The rule was first keyed on `device:$n`, filtered by admitting the
//     target to the planner's universe only for additions. That did nothing:
//     `$n` targets are expanded by substitution, not looked up in the universe,
//     so it fired on every port move, type change and removal as well.
//     Additions now carry their own component id and the edge keys off that.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { componentsOf, actionFor } from '../src/planner.js'
import { BUILTIN_EDGES } from '../src/graph.js'

const APP = fileURLToPath(new URL('..', import.meta.url))

const BASE_XML = `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="e" parentModuleAddress="173"><LynxModule name="Control Hub" port="173">
<goBILDA5202SeriesMotor name="leftDrive" port="0" /><goBILDA5202SeriesMotor name="armMotor" port="2" />
</LynxModule></LynxUsbDevice></Robot>`
const code = (...names) =>
  `class T { void i(HardwareMap h){ ${names.map((n, i) => `v${i} = h.get(DcMotor.class, "${n}");`).join(' ')} } }`

function project() {
  const root = mkdtempSync(join(tmpdir(), 'physync-devnew-'))
  const dir = join(root, 'robot'), home = join(root, 'home')
  mkdirSync(join(dir, 'code'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dir, 'r.xml'), BASE_XML)
  writeFileSync(join(dir, 'code/T.java'), code('leftDrive', 'armMotor'))
  const p = { dir, home }
  run(p, ['init', '--config', 'r.xml', '--code', 'code', '--by', 'T'])
  run(p, ['state', '--config', 'r.xml', '--code', 'code'])
  return p
}
function run(p, a) {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], {
    cwd: p.dir, encoding: 'utf8',
    env: { ...process.env, HOME: p.home, USERPROFILE: p.home },
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
}
const xml = (p, fn) => writeFileSync(join(p.dir, 'r.xml'), fn(readFileSync(join(p.dir, 'r.xml'), 'utf8')))
const demands = (p) => (run(p, ['status', '--reveal']).out.match(/newly declared/g) ?? []).length

test('adding a device demands that it be verified, with a reason and a path', () => {
  const p = project()
  xml(p, (s) => s.replace('</LynxModule>', '<Servo name="claw" port="0" /></LynxModule>'))
  writeFileSync(join(p.dir, 'code/T.java'), code('leftDrive', 'armMotor', 'claw'))
  const out = run(p, ['status', '--reveal']).out
  assert.match(out, /confirm the newly declared device "claw" is present/)
  assert.match(out, /device "claw" was added to the configuration/, 'and says why')
  assert.match(out, /device-added:\$n → device-verified:\$n \(deterministic rule\)/, 'with a traceable path')
})

test('a team can actually discharge it — the demand is not permanent', () => {
  // The first version produced `verify-device:<name>`, which nothing could
  // satisfy. An undischargeable requirement would sit on the screen forever.
  const p = project()
  xml(p, (s) => s.replace('</LynxModule>', '<Servo name="claw" port="0" /></LynxModule>'))
  writeFileSync(join(p.dir, 'code/T.java'), code('leftDrive', 'armMotor', 'claw'))
  const before = run(p, ['status', '--reveal']).out
  assert.match(before, /recheck\(s\) owed/)
  assert.match(before, /record it: \S*\s*result --test device-claw/, 'and it prints the command')

  run(p, ['result', '--test', 'device-claw', '--pass', '--by', 'Marcus'])
  const after = run(p, ['status', '--reveal']).out
  assert.match(after, /SATISFIED BY THIS RUN/)
  assert.match(after, /device "claw".*PASS recorded .* by Marcus/s, 'credited to whoever did it')
  assert.ok(!/0 recheck/.test(before), 'sanity: there was a demand to clear')
})

test('it fires ONLY on additions, not on any other device change', () => {
  // The first version keyed on device:$n and tried to filter by universe
  // admission, which does nothing — $n targets are substituted, not looked up.
  // It therefore fired on all four kinds.
  for (const [label, mutate, codeNames] of [
    ['port move',   (s) => s.replace('name="armMotor" port="2"', 'name="armMotor" port="3"'), ['leftDrive', 'armMotor']],
    ['type change', (s) => s.replace('goBILDA5202SeriesMotor name="armMotor"', 'RevRoboticsCoreHexMotor name="armMotor"'), ['leftDrive', 'armMotor']],
    ['removal',     (s) => s.replace('<goBILDA5202SeriesMotor name="armMotor" port="2" />', ''), ['leftDrive']],
  ]) {
    const p = project()
    xml(p, mutate)
    writeFileSync(join(p.dir, 'code/T.java'), code(...codeNames))
    assert.equal(demands(p), 0, `${label} must not demand a new-device verification`)
  }
})

test('an unchanged robot demands nothing', () => {
  assert.equal(demands(project()), 0)
})

test('two added devices produce one demand each, named separately', () => {
  const p = project()
  xml(p, (s) => s.replace('</LynxModule>',
    '<Servo name="claw" port="0" /><Servo name="wrist" port="1" /></LynxModule>'))
  writeFileSync(join(p.dir, 'code/T.java'), code('leftDrive', 'armMotor', 'claw', 'wrist'))
  const out = run(p, ['status', '--reveal']).out
  assert.equal(demands(p), 2)
  assert.match(out, /"claw"/)
  assert.match(out, /"wrist"/)
})

test('componentsOf gives an addition its own id, and nothing else does', () => {
  assert.deepEqual(componentsOf({ kind: 'device-added', component: 'device "claw"' }),
    ['device:claw', 'device-added:claw'])
  for (const kind of ['device-removed', 'device-type-changed', 'device-port-moved']) {
    assert.deepEqual(componentsOf({ kind, component: 'device "claw"' }), ['device:claw'],
      `${kind} must not carry the addition id`)
  }
})

test('the action is a test: so the existing satisfaction path applies', () => {
  const a = actionFor('device-verified:claw')
  assert.equal(a.action, 'test:device-claw',
    'any other prefix is undischargeable — assess.js clears only test:/calibration:')
  assert.match(a.label, /newly declared device "claw"/)
})

test('the rule ships ACTIVE and carries deterministic provenance', () => {
  const e = BUILTIN_EDGES.find((x) => x.id === 'ftc:device-new')
  assert.ok(e, 'the edge must be built in — it asserts a fact about the ledger, not a guess')
  assert.equal(e.from, 'device-added:$n')
  assert.equal(e.to, 'device-verified:$n')
  assert.equal(e.source, 'deterministic-rule')
  assert.match(e.note, /no recorded evidence/)
})

test('the label never claims to know what KIND of device it is', () => {
  // The planner is CORE and must not learn FTC device types; the built-in
  // per-device edges are type-blind, so a type-specific label here would be a
  // guess. "present and does what the code expects" is right for a motor, a
  // servo and a sensor alike.
  for (const n of ['claw', 'frontColor', 'armMotor']) {
    const { label } = actionFor(`device-verified:${n}`)
    // The device's own NAME is quoted in the label and may itself contain
    // "motor" — that is the team's word, not a claim by Nexum. Check the
    // framing around it.
    const framing = label.replace(/"[^"]*"/g, '"<name>"')
    assert.ok(!/motor|servo|sensor|camera/i.test(framing),
      `label must stay type-agnostic: ${framing}`)
  }
})

test('a hand-declared inventory gets the same rule — it is platform-independent', () => {
  // The rule keys on the CHANGE KIND, not on anything FTC-specific, so a VEX
  // team adding a motor to their hand-written inventory is owed the same
  // confirmation. Worth pinning: the planner must never learn a platform.
  const root = mkdtempSync(join(tmpdir(), 'physync-devnew-vex-'))
  const dir = join(root, 'robot'), home = join(root, 'home')
  mkdirSync(dir, { recursive: true }); mkdirSync(home, { recursive: true })
  const inv = (devices) => JSON.stringify({
    format: 'physync-inventory-v1', platform: 'vex-v5', declaredBy: 'Ashrith', devices,
  }, null, 2)
  const base = [{ name: 'leftDrive', type: 'motor', port: '1' }]
  writeFileSync(join(dir, 'inv.json'), inv(base))
  const p2 = { dir, home }
  run(p2, ['init', '--declare', 'inv.json', '--by', 'Ashrith'])
  run(p2, ['state', '--declare', 'inv.json'])
  writeFileSync(join(dir, 'inv.json'), inv([...base, { name: 'intake', type: 'motor', port: '5' }]))
  const out = run(p2, ['status', '--declare', 'inv.json', '--reveal']).out
  assert.match(out, /confirm the newly declared device "intake" is present/)
})

test('a device SWAP still demands nothing without approved rules', () => {
  // Deliberate, and documented in VIDEO-SCRIPT.md: replacing a device is not
  // an addition, so only the team's own approved rules can say what it
  // affected. If this ever starts demanding something, that document becomes
  // false and the demo video built on it becomes misleading.
  const p = project()
  xml(p, (s) => s.replace('<goBILDA5202SeriesMotor name="armMotor" port="2" />',
                          '<Servo name="armMotor" port="0" />'))
  const out = run(p, ['status', '--reveal']).out
  assert.match(out, /0 recheck\(s\) owed/)
  assert.ok(!/newly declared/.test(out), 'a swap is a type change, not an addition')
})
