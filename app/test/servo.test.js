// Servo command checks. The boundary these lock: PHYSYNC flags values that are
// wrong ON THEIR FACE (outside 0–1, arguments the SDK throws on) and config/code
// contradictions — and stays silent about anything that depends on the physical
// mechanism, which it cannot see. An unresolvable argument is never guessed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigXml } from '../src/configXml.js'
import { scanSources, scanServoUsage, collectNumericConstants } from '../src/codeScan.js'
import { reconcile, verdict } from '../src/engine.js'
import { CHECKS } from '../src/registry.js'

const KNOWN = new Set(CHECKS.map((c) => c.id))
const wrap = (devices) => `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173">${devices}</LynxModule></LynxUsbDevice></Robot>`
const DEVICES = '<Servo name="claw" port="0" /><ContinuousRotationServo name="intake" port="1" /><Servo name="wrist" port="2" />'

const run = (body, devices = DEVICES) => {
  const config = parseConfigXml(wrap(devices))
  const names = new Set(config.devices.map((d) => d.name))
  const spaces = new Map(config.devices.map((d) => [d.name, d.space]))
  const scan = scanSources([{ name: 'T.java', content: `public class T { void init(HardwareMap hardwareMap) {\n${body}\n} }` }], names, spaces)
  return reconcile(config, scan)
}
const servoIds = (fs) => fs.filter((f) => f.checkId.startsWith('servo-')).map((f) => f.checkId).sort()

// ── position range: fire / stay quiet ──────────────────────────────────────
test('servo: a literal position above 1.0 FAILs', () => {
  const f = run('Servo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(1.4);')
  assert.deepEqual(servoIds(f), ['servo-position-out-of-range'])
  assert.equal(verdict(f), 'FAIL')
  assert.match(f.find((x) => x.checkId === 'servo-position-out-of-range').fix, /clamps this/)
})
test('servo: a negative literal position FAILs', () => {
  assert.ok(run('Servo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(-0.2);').some((x) => x.checkId === 'servo-position-out-of-range'))
})
test('servo: an out-of-range value reached through a named constant is still caught', () => {
  const config = parseConfigXml(wrap(DEVICES))
  const names = new Set(config.devices.map((d) => d.name))
  const scan = scanSources([
    { name: 'Consts.java', content: 'public class Consts { public static final double CLAW_OPEN = 1.8; }' },
    { name: 'T.java', content: 'public class T { void init(HardwareMap hardwareMap) {\nServo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(Consts.CLAW_OPEN);\n} }' },
  ], names, new Map())
  const f = reconcile(config, scan)
  assert.ok(f.some((x) => x.checkId === 'servo-position-out-of-range' && /1\.8/.test(x.message)))
})
test('servo: legal positions including the exact endpoints stay quiet', () => {
  const f = run('Servo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(0.0);\nclaw.setPosition(1.0);\nclaw.setPosition(0.37);')
  assert.deepEqual(servoIds(f), [])
})
test('servo: an argument PHYSYNC cannot resolve is never guessed at', () => {
  const f = run('Servo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(computeTarget(gamepad1.left_stick_y));')
  assert.deepEqual(servoIds(f), [], 'a runtime-computed position is not a finding')
})

// ── scaleRange: fire / stay quiet ──────────────────────────────────────────
for (const [label, call] of [
  ['inverted (min ≥ max)', 'scaleRange(0.8, 0.2)'],
  ['min below zero', 'scaleRange(-0.1, 0.9)'],
  ['max above one', 'scaleRange(0.1, 1.4)'],
  ['degenerate (min == max)', 'scaleRange(0.5, 0.5)'],
]) {
  test(`servo: scaleRange ${label} FAILs`, () => {
    const f = run(`Servo wrist = hardwareMap.get(Servo.class, "wrist");\nwrist.${call};`)
    assert.ok(f.some((x) => x.checkId === 'servo-scale-range-invalid'), `${call} should fail`)
    assert.equal(verdict(f), 'FAIL')
  })
}
test('servo: a valid scaleRange stays quiet', () => {
  assert.deepEqual(servoIds(run('Servo wrist = hardwareMap.get(Servo.class, "wrist");\nwrist.scaleRange(0.2, 0.8);\nwrist.setPosition(1.0);')), [])
})

// ── class mismatch: fire / stay quiet ──────────────────────────────────────
test('servo: setPosition on a continuous-rotation device FAILs with the right fix', () => {
  const f = run('Servo intake = hardwareMap.get(Servo.class, "intake");\nintake.setPosition(0.5);')
  const mismatch = f.filter((x) => x.checkId === 'servo-class-mismatch')
  assert.ok(mismatch.length >= 1)
  assert.ok(mismatch.some((x) => /setPower/.test(x.fix)))
  assert.equal(verdict(f), 'FAIL')
})
test('servo: requesting CRServo for a positional servo FAILs', () => {
  const f = run('CRServo claw = hardwareMap.get(CRServo.class, "claw");')
  assert.ok(f.some((x) => x.checkId === 'servo-class-mismatch' && /CRServo/.test(x.message)))
})
test('servo: matching classes stay quiet in both directions', () => {
  assert.deepEqual(servoIds(run('Servo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(0.5);')), [])
  assert.deepEqual(servoIds(run('CRServo intake = hardwareMap.get(CRServo.class, "intake");')), [])
})
test('servo: a class mismatch is reported once per device, not once per call', () => {
  const f = run('Servo intake = hardwareMap.get(Servo.class, "intake");\nintake.setPosition(0.1);\nintake.setPosition(0.2);\nintake.setPosition(0.3);')
  assert.equal(f.filter((x) => x.checkId === 'servo-class-mismatch' && /calls setPosition/.test(x.message)).length, 1)
})

// ── scanner behavior ───────────────────────────────────────────────────────
test('servo scanner: setPosition on an untraceable variable produces nothing (no crash)', () => {
  const out = scanServoUsage('someRandomObject.setPosition(9.9);', 'T.java')
  assert.deepEqual(out.calls, [])
})
test('servo scanner: commented-out servo calls are dead code', () => {
  const out = scanServoUsage([
    'Servo claw = hardwareMap.get(Servo.class, "claw");',
    '// claw.setPosition(5.0);',
    '/* claw.scaleRange(9, 1); */',
  ].join('\n'), 'T.java')
  assert.deepEqual(out.calls, [])
})
test('servo scanner: numeric constants are collected with float suffixes and negatives', () => {
  const m = collectNumericConstants('public static final double A = 0.5;\npublic static final float B = -1.25f;\n')
  assert.equal(m.get('A'), 0.5)
  assert.equal(m.get('B'), -1.25)
})
test('servo scanner: binding records the requested class for the mismatch check', () => {
  const out = scanServoUsage('Servo claw = hardwareMap.get(Servo.class, "claw");', 'T.java')
  assert.equal(out.bindings[0].device, 'claw')
  assert.equal(out.bindings[0].requestedClass, 'Servo')
})
test('servo scanner: Kotlin ::class.java bindings are traced too', () => {
  const out = scanServoUsage('val claw = hardwareMap.get(Servo::class.java, "claw")\nclaw.setPosition(1.9)', 'T.kt')
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].device, 'claw')
})

// ── shape ──────────────────────────────────────────────────────────────────
test('servo: every emitted finding uses a registered check with full shape and evidence', () => {
  const f = run([
    'Servo claw = hardwareMap.get(Servo.class, "claw");',
    'Servo intake = hardwareMap.get(Servo.class, "intake");',
    'Servo wrist = hardwareMap.get(Servo.class, "wrist");',
    'claw.setPosition(1.4);',
    'intake.setPosition(0.5);',
    'wrist.scaleRange(0.9, 0.1);',
  ].join('\n')).filter((x) => x.checkId.startsWith('servo-'))
  assert.ok(f.length >= 3)
  for (const x of f) {
    assert.ok(KNOWN.has(x.checkId))
    assert.equal(x.severity, 'FAIL')
    assert.ok(Array.isArray(x.evidence) && typeof x.fix === 'string' && x.message)
  }
  assert.ok(f.some((x) => x.evidence.some((e) => /T\.java:\d+/.test(e))), 'findings must cite file:line')
})
test('servo: a device commanded but absent from the config produces no servo finding (the name check owns that)', () => {
  const f = run('Servo ghost = hardwareMap.get(Servo.class, "ghost");\nghost.setPosition(1.4);')
  assert.ok(f.some((x) => x.checkId === 'code-name-missing'))
  assert.ok(!f.some((x) => x.checkId === 'servo-class-mismatch'), 'no type to contradict')
})

// ── Fleet round 4: the two shapes that got no servo checking at all ─────────
test('chained: hardwareMap.get(Servo.class,"claw").setPosition(1.4) is checked like any other call', () => {
  const out = scanServoUsage('hardwareMap.get(Servo.class, "claw").setPosition(1.4);', 'T.java')
  assert.equal(out.calls.length, 1)
  assert.deepEqual({ device: out.calls[0].device, method: out.calls[0].method, args: out.calls[0].args }, { device: 'claw', method: 'setPosition', args: [1.4] })
  const f = run('hardwareMap.get(Servo.class, "claw").setPosition(1.4);', '<Servo name="claw" port="0" />')
  assert.ok(f.some((x) => x.checkId === 'servo-position-out-of-range'))
})

test('chained: the Kotlin form and scaleRange are traced too', () => {
  const kt = scanServoUsage('hardwareMap.get(Servo::class.java, "claw").setPosition(-0.2)', 'T.kt')
  assert.equal(kt.calls[0]?.device, 'claw')
  assert.equal(kt.calls[0]?.args[0], -0.2)
  const sr = scanServoUsage('hardwareMap.get(Servo.class, "wrist").scaleRange(0.8, 0.2);', 'T.java')
  assert.deepEqual(sr.calls[0]?.args, [0.8, 0.2])
})

test('chained: nested arguments still are not spliced, and a string literal is still inert', () => {
  const nested = scanServoUsage('hardwareMap.get(Servo.class, "w").setPosition(Range.clip(v, 0.0, 1.0));', 'T.java')
  assert.deepEqual(nested.calls[0]?.args, [null], 'one unresolvable argument, not three literals')
  const inStr = scanServoUsage('String doc = "hardwareMap.get(Servo.class, x).setPosition(1.4)";', 'T.java')
  assert.equal(inStr.calls.length, 0)
})

test('a chained call also carries its class contradiction', () => {
  const f = run('hardwareMap.get(Servo.class, "spin").setPosition(0.5);', '<CRServo name="spin" port="0" />')
  assert.ok(f.some((x) => x.checkId === 'servo-class-mismatch'))
})

test('requesting a servo class on a device that is not a servo FAILs (it used to be invisible)', () => {
  const motor = run('Servo lift = hardwareMap.get(Servo.class, "lift");', '<Motor name="lift" port="0" />')
  const m = motor.find((x) => x.checkId === 'servo-class-mismatch')
  assert.ok(m, 'get(Servo.class) on a Motor entry throws at init')
  assert.match(m.message, /that is not a servo/)
  const blinkin = run('CRServo lights = hardwareMap.get(CRServo.class, "lights");', '<RevBlinkinLedDriver name="lights" port="0" />')
  assert.ok(blinkin.some((x) => x.checkId === 'servo-class-mismatch'), 'a servo-PORT device is still not a servo')
})

test('an unrecognized custom driver is never class-FAILed on a guess', () => {
  const f = run('Servo odd = hardwareMap.get(Servo.class, "odd");', '<MyCustomServoDriver name="odd" port="0" />')
  assert.ok(!f.some((x) => x.checkId === 'servo-class-mismatch'), 'a custom driver may legitimately extend Servo')
})
