// Matrix suites — table-driven coverage sweeps. Every row is a named test
// with a real assertion: the full FTC device vocabulary against port-space
// classification, every check's fire AND stay-quiet boundary, every scanner
// lookup form, parser edge cases, drift classes, and the CLI exit-code
// contract. No padding: a row that can't fail honestly doesn't belong here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfigXml, portSpace, toSnapshot } from '../src/configXml.js'
import { scanJavaSource } from '../src/codeScan.js'
import { reconcile, diffSnapshot, verdict } from '../src/engine.js'

const APP = new URL('..', import.meta.url).pathname
const wrap = (devices, portalAttrs = 'name="P" serialNumber="X" parentModuleAddress="173"', hubs = null) =>
  `<Robot type="FirstInspires-FTC"><LynxUsbDevice ${portalAttrs}>${hubs ?? `<LynxModule name="Control Hub" port="173">${devices}</LynxModule>`}</LynxUsbDevice></Robot>`
const audit = (xml, code = {}) => reconcile(parseConfigXml(xml), { refs: [], dynamic: [], blocksUnknown: [], filesScanned: 1, ...code })

// ── Suite 1: device-vocabulary → port-space matrix ─────────────────────────
// Expected values follow the classifier's design contract. Tags with no
// recognizable keyword are EXPECTED null — that is the unknown-device-type
// path, surfaced as a WARN rather than silently exempted.
const VOCAB = [
  ['Motor', {}, 'motor'],
  ['goBILDA5202SeriesMotor', {}, 'motor'],
  ['goBILDA5201SeriesMotor', {}, 'motor'],
  ['NeveRest20Gearmotor', {}, 'motor'],
  ['NeveRest40Gearmotor', {}, 'motor'],
  ['TetrixMotor', {}, 'motor'],
  ['Matrix12vMotor', {}, 'motor'],
  ['RevRoboticsUltraplanetaryHDHexMotor', {}, 'motor'],
  ['RevRobotics20HDHexMotor', {}, 'motor'],
  ['Servo', {}, 'servo'],
  ['ContinuousRotationServo', {}, 'servo'],
  ['RevBlinkinLedDriver', {}, 'servo'],
  ['RevSPARKMini', {}, 'servo'],
  ['RevTouchSensor', {}, 'digital'],
  ['Led', {}, 'digital'],
  ['DigitalDevice', {}, 'digital'],
  ['AnalogInput', {}, 'analog'],
  ['AnalogDevice', {}, 'analog'],
  ['Potentiometer', {}, 'analog'],
  ['RevColorSensorV3', { bus: '2' }, 'i2c-bus2'],
  ['RevColorSensorV3', {}, 'i2c-bus0'],
  ['Rev2mDistanceSensor', {}, 'i2c-bus0'],
  ['LynxEmbeddedIMU', {}, 'i2c-bus0'],
  ['AdafruitBNO055IMU', {}, 'i2c-bus0'],
  ['KauaiLabsNavxMicro', {}, 'i2c-bus0'],
  ['HuskyLens', {}, 'i2c-bus0'],
  ['SparkFunOTOS', {}, 'i2c-bus0'],
  ['ModernRoboticsI2cGyro', {}, 'i2c-bus0'],
  ['TorqueNADO', {}, null],
  ['OctoQuadFTC', {}, null],
  ['Webcam', {}, null],
]
for (const [tag, attrs, expected] of VOCAB) {
  test(`vocab: ${tag}${attrs.bus ? ` (bus ${attrs.bus})` : ''} → ${expected ?? 'unknown (WARN path)'}`, () => {
    assert.equal(portSpace(tag, attrs), expected)
  })
}

// ── Suite 2: check fire / stay-quiet boundary matrix ───────────────────────
const CHECKS = [
  ['code-name-missing',
    { xml: wrap('<Motor name="m" port="0" />'), code: { refs: [{ name: 'ghost', file: 'T.java', line: 1 }] } },
    { xml: wrap('<Motor name="m" port="0" />'), code: { refs: [{ name: 'm', file: 'T.java', line: 1 }] } }],
  ['config-name-unused',
    { xml: wrap('<Motor name="m" port="0" />'), code: {} },
    { xml: wrap('<Motor name="m" port="0" />'), code: { refs: [{ name: 'm', file: 'T.java', line: 1 }] } }],
  ['duplicate-name',
    { xml: wrap('<Motor name="m" port="0" /><Servo name="m" port="0" />'), code: {} },
    { xml: wrap('<Motor name="m" port="0" /><Servo name="s" port="0" />'), code: {} }],
  ['port-collision',
    { xml: wrap('<Motor name="a" port="0" /><Motor name="b" port="0" />'), code: {} },
    { xml: wrap('<Motor name="a" port="0" /><Servo name="b" port="0" />'), code: {} }],
  ['port-range',
    { xml: wrap('<Motor name="m" port="5" />'), code: {} },
    { xml: wrap('<Motor name="m" port="3" />'), code: {} }],
  ['i2c-address-conflict',
    { xml: wrap('<RevColorSensorV3 name="a" port="0" bus="1" /><RevColorSensorV3 name="b" port="1" bus="1" />'), code: {} },
    { xml: wrap('<RevColorSensorV3 name="a" port="0" bus="1" /><RevColorSensorV3 name="b" port="0" bus="2" />'), code: {} }],
  ['digital-pair-overlap',
    { xml: wrap('<RevTouchSensor name="t" port="1" /><Led name="l" port="0" />'), code: {} },
    { xml: wrap('<RevTouchSensor name="t" port="1" /><Led name="l" port="2" />'), code: {} }],
  ['hub-address-conflict',
    { xml: wrap(null, 'name="P" serialNumber="X" parentModuleAddress="2"', '<LynxModule name="A" port="2"><Motor name="m" port="0" /></LynxModule><LynxModule name="B" port="2"><Motor name="n" port="0" /></LynxModule>'), code: {} },
    { xml: wrap(null, 'name="P" serialNumber="X" parentModuleAddress="2"', '<LynxModule name="A" port="2"><Motor name="m" port="0" /></LynxModule><LynxModule name="B" port="3"><Motor name="n" port="0" /></LynxModule>'), code: {} }],
  ['parent-address-mismatch',
    { xml: wrap('<Motor name="m" port="0" />', 'name="P" serialNumber="X" parentModuleAddress="9"'), code: {} },
    { xml: wrap('<Motor name="m" port="0" />'), code: {} }],
  ['name-hygiene',
    { xml: wrap('<Motor name="Claw" port="0" /><Servo name="claw" port="0" />'), code: {} },
    { xml: wrap('<Motor name="claw" port="0" /><Servo name="arm" port="0" />'), code: {} }],
  ['unknown-device-type',
    { xml: wrap('<MysteryCustomDriver name="x" port="0" />'), code: {} },
    { xml: wrap('<Motor name="x" port="0" />'), code: {} }],
  ['dynamic-name',
    { xml: wrap('<Motor name="m" port="0" />'), code: { dynamic: [{ expr: '"pod" + i', file: 'T.java', line: 1 }] } },
    { xml: wrap('<Motor name="m" port="0" />'), code: {} }],
  ['blocks-name-unknown',
    { xml: wrap('<Motor name="m" port="0" />'), code: { blocksUnknown: [{ identifier: 'ghostAsDcMotor', base: 'ghost', file: 'T.blk', kind: 'stale' }] } },
    { xml: wrap('<Motor name="m" port="0" />'), code: {} }],
  ['unparsed',
    { xml: wrap('<Motor name="a" name="b" port="0" />'), code: {} },
    { xml: wrap('<Motor name="a" port="0" />'), code: {} }],
]
for (const [id, fire, quiet] of CHECKS) {
  test(`check ${id}: fires on its trigger`, () => {
    assert.ok(audit(fire.xml, fire.code).some((f) => f.checkId === id), `${id} should fire`)
  })
  test(`check ${id}: stays quiet on the near-miss`, () => {
    assert.ok(!audit(quiet.xml, quiet.code).some((f) => f.checkId === id), `${id} must not fire`)
  })
}

// ── Suite 3: verdict logic ─────────────────────────────────────────────────
test('verdict: any FAIL finding → FAIL', () => {
  assert.equal(verdict([{ severity: 'WARN' }, { severity: 'FAIL' }, { severity: 'INFO' }]), 'FAIL')
})
test('verdict: WARN/INFO only → PASS', () => {
  assert.equal(verdict([{ severity: 'WARN' }, { severity: 'INFO' }]), 'PASS')
})
test('verdict: empty findings → PASS', () => {
  assert.equal(verdict([]), 'PASS')
})

// ── Suite 4: drift class matrix ────────────────────────────────────────────
const DRIFTS = [
  ['hub serial swap', wrap('<Motor name="m" port="0" />'), wrap('<Motor name="m" port="0" />', 'name="P" serialNumber="NEW" parentModuleAddress="173"'), /serial changed/],
  ['device moved port', wrap('<Motor name="m" port="0" />'), wrap('<Motor name="m" port="1" />'), /moved/],
  ['device removed', wrap('<Motor name="m" port="0" /><Servo name="s" port="0" />'), wrap('<Motor name="m" port="0" />'), /removed/],
  ['device added', wrap('<Motor name="m" port="0" />'), wrap('<Motor name="m" port="0" /><Servo name="s" port="0" />'), /added/],
  ['device type change', wrap('<goBILDA5202SeriesMotor name="m" port="0" />'), wrap('<NeveRest20Gearmotor name="m" port="0" />'), /changed type/],
]
for (const [label, beforeXml, afterXml, pattern] of DRIFTS) {
  test(`drift: ${label} is detected`, () => {
    const findings = diffSnapshot(toSnapshot(parseConfigXml(beforeXml)), toSnapshot(parseConfigXml(afterXml)))
    assert.ok(findings.some((f) => pattern.test(f.message)), `expected ${pattern}`)
  })
}

// ── Suite 5: scanner lookup-form matrix ────────────────────────────────────
const FORMS = [
  ['class form, hardwareMap', 'a = hardwareMap.get(DcMotorEx.class, "n1");', 'n1'],
  ['class form, wrapper receiver', 'a = hw.get(Servo.class, "n2");', 'n2'],
  ['tryGet form', 'a = hardwareMap.tryGet(IMU.class, "n3");', 'n3'],
  ['Kotlin ::class.java, any receiver', 'val a = x.get(DcMotorEx::class.java, "n4")', 'n4'],
  ['typed map dcMotor', 'a = hardwareMap.dcMotor.get("n5");', 'n5'],
  ['typed map servo, wrapper receiver', 'a = robot.servo.get("n6");', 'n6'],
  ['typed map colorSensor', 'a = hardwareMap.colorSensor.get("n7");', 'n7'],
  ['typed map touchSensor', 'a = hwMap.touchSensor.get("n8");', 'n8'],
  ['bare form hardwareMap', 'a = hardwareMap.get("n9");', 'n9'],
  ['bare form hwMap', 'a = hwMap.get("n10");', 'n10'],
]
for (const [label, src, expected] of FORMS) {
  test(`scanner: ${label} → "${expected}"`, () => {
    const out = scanJavaSource(src, 'T.java')
    assert.deepEqual(out.refs.map((r) => r.name), [expected])
  })
}
const NON_FORMS = [
  ['generic Map.get is not a hardware lookup', 'v = someMap.get("key");'],
  ['line-commented lookup is dead', '// a = hardwareMap.get(DcMotor.class, "dead");'],
  ['block-commented lookup is dead', '/* a = hardwareMap.get(DcMotor.class, "dead"); */'],
  ['string concat is dynamic, not a ref', 'a = hardwareMap.get(DcMotor.class, "pod" + i + "_m");'],
  ['unresolved identifier is dynamic, not a ref', 'a = hardwareMap.get(DcMotor.class, SOME_CONST);'],
]
for (const [label, src] of NON_FORMS) {
  test(`scanner: ${label}`, () => {
    assert.equal(scanJavaSource(src, 'T.java').refs.length, 0)
  })
}

// ── Suite 6: parser edge cases ─────────────────────────────────────────────
test('parser: CRLF line endings keep correct line numbers', () => {
  const m = parseConfigXml(wrap('<Motor name="m" port="0" />').replace(/></g, '>\r\n<'))
  assert.equal(m.devices.length, 1)
  assert.ok(m.devices[0].line > 1)
})
test('parser: unicode device names survive', () => {
  const m = parseConfigXml(wrap('<Motor name="ïmu_mötor" port="0" />'))
  assert.equal(m.devices[0].name, 'ïmu_mötor')
})
test('parser: paired (non-self-closing) device tag parses once', () => {
  const m = parseConfigXml(wrap('<Motor name="m" port="0"></Motor>'))
  assert.equal(m.devices.length, 1)
})
test('parser: >2MB input throws the size guard', () => {
  assert.throws(() => parseConfigXml('x'.repeat(2_000_001)), /too large/)
})
test('parser: non-FTC XML flags isFtcConfig false', () => {
  assert.equal(parseConfigXml('<network><listener name="l" port="80"/></network>').isFtcConfig, false)
})
test('parser: LynxModule outside a portal is surfaced as unparsed', () => {
  const m = parseConfigXml('<Robot type="FirstInspires-FTC"><LynxModule name="orphan" port="2"><Motor name="m" port="0" /></LynxModule></Robot>')
  assert.ok(m.unparsed.some((u) => /orphan/.test(u.text)))
})
test('parser: webcam serial captured', () => {
  const m = parseConfigXml('<Robot type="FirstInspires-FTC"><Webcam name="Webcam 1" serialNumber="ABC123" /></Robot>')
  assert.equal(m.webcams[0].serialNumber, 'ABC123')
})
test('parser: portal serial and parent address captured', () => {
  const m = parseConfigXml(wrap('<Motor name="m" port="0" />'))
  assert.equal(m.portals[0].serialNumber, 'X')
  assert.equal(m.portals[0].parentModuleAddress, 173)
})

// ── Suite 7: CLI exit-code contract ────────────────────────────────────────
const cli = (cliArgs, cwd) => {
  try {
    const stdout = execFileSync(process.execPath, [join(APP, 'bin/physync.js'), ...cliArgs], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return { status: 0, stdout }
  } catch (e) { return { status: e.status, stdout: String(e.stdout ?? '') } }
}
const dir = mkdtempSync(join(tmpdir(), 'physync-cli-'))
writeFileSync(join(dir, 'pass.xml'), wrap('<Motor name="m" port="0" />'))
mkdirSync(join(dir, 'code'))
writeFileSync(join(dir, 'code/T.java'), 'a = hardwareMap.get(DcMotor.class, "m");')
writeFileSync(join(dir, 'webcams.xml'), '<Robot type="FirstInspires-FTC"><Webcam name="W" serialNumber="A" /></Robot>')

test('cli: passing robot → exit 0', () => {
  assert.equal(cli(['check', '--config', 'pass.xml', '--code', 'code'], dir).status, 0)
})
test('cli: failing robot (samples) → exit 2', () => {
  assert.equal(cli(['check', '--config', join(APP, 'samples/config.xml'), '--code', join(APP, 'samples/TeamCode')], dir).status, 2)
})
test('cli: no arguments → usage, exit 1', () => {
  assert.equal(cli([], dir).status, 1)
})
test('cli: unknown subcommand → exit 1', () => {
  assert.equal(cli(['frobnicate'], dir).status, 1)
})
test('cli: check without --code → exit 1', () => {
  assert.equal(cli(['check', '--config', 'pass.xml'], dir).status, 1)
})
test('cli: snapshot of device-less config refused → exit 1', () => {
  assert.equal(cli(['snapshot', '--config', 'webcams.xml'], dir).status, 1)
})
test('cli: diff without a snapshot → exit 1', () => {
  assert.equal(cli(['diff', '--config', 'pass.xml'], dir).status, 1)
})
test('cli: --json emits schema v1 with matching verdict and exit code', () => {
  const r = cli(['check', '--config', 'pass.xml', '--code', 'code', '--json'], dir)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.physync, 1)
  assert.equal(parsed.verdict, 'PASS')
  assert.equal(r.status, 0)
  assert.ok('blkCount' in parsed.context && 'engineVersion' in parsed.context)
})