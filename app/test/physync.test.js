// PHYSYNC v1 test suite — parser, scanner, every check, drift, and the CLI
// end-to-end on the samples. If these break, a team trusts a wrong PASS.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseConfigXml, toSnapshot, portSpace } from '../src/configXml.js'
import { scanJavaSource, scanCodeDir } from '../src/codeScan.js'
import { reconcile, diffSnapshot, verdict, editDistance } from '../src/engine.js'
import { renderMarkdown } from '../src/report.js'

const SAMPLE_XML = new URL('../samples/config.xml', import.meta.url)
const SAMPLE_CODE = new URL('../samples/TeamCode', import.meta.url).pathname
const sampleConfig = () => parseConfigXml(readFileSync(SAMPLE_XML, 'utf8'))

test('configXml: parses portals, hubs, devices with ports/buses/lines', () => {
  const m = sampleConfig()
  assert.equal(m.portals.length, 1)
  assert.equal(m.portals[0].hubs.length, 2)
  assert.equal(m.devices.length, 11)
  const imu = m.devices.find((d) => d.name === 'imu')
  assert.equal(imu.bus, 0)
  assert.equal(imu.space, 'i2c-bus0')
  assert.equal(m.devices.find((d) => d.name === 'lift_left').hubAddress, 2)
  assert.ok(imu.line > 0)
  assert.equal(m.unparsed.length, 0)
})

test('configXml: port spaces classified correctly', () => {
  assert.equal(portSpace('goBILDA5202SeriesMotor', {}), 'motor')
  assert.equal(portSpace('ContinuousRotationServo', {}), 'servo')
  assert.equal(portSpace('RevTouchSensor', {}), 'digital')
  assert.equal(portSpace('RevColorSensorV3', { bus: '1' }), 'i2c-bus1')
  assert.equal(portSpace('MysteryDevice9000', {}), null)
})

test('codeScan: catches every SDK lookup style with file:line', () => {
  const src = [
    'DcMotorEx a = hardwareMap.get(DcMotorEx.class, "left_drive");',
    'Servo b = hardwareMap.servo.get("claw");',
    'DcMotor c = hardwareMap.dcMotor.get("arm_motor");',
    'DcMotorEx d = hardwareMap.tryGet(DcMotorEx.class, "hang_motor");',
    'IMU e = hwMap.get(IMU.class, "imu");',
  ].join('\n')
  const { refs } = scanJavaSource(src, 'X.java')
  assert.deepEqual(refs.map((r) => r.name), ['left_drive', 'claw', 'arm_motor', 'hang_motor', 'imu'])
  assert.equal(refs[1].line, 2)
  assert.equal(refs[0].via, 'DcMotorEx')
})

test('engine: missing code name FAILs with did-you-mean typo suggestion', () => {
  const code = { refs: [{ name: 'wrsit', file: 'T.java', line: 9 }], filesScanned: 1 }
  const findings = reconcile(sampleConfig(), code)
  const missing = findings.find((f) => f.checkId === 'code-name-missing')
  assert.match(missing.message, /did you mean "wrist"/)
  assert.deepEqual(missing.evidence, ['T.java:9'])
  assert.equal(verdict(findings), 'FAIL')
})

test('engine: unused config devices WARN, referenced ones do not', () => {
  const code = { refs: sampleConfig().devices.map((d) => ({ name: d.name, file: 'A.java', line: 1 })), filesScanned: 1 }
  assert.equal(reconcile(sampleConfig(), code).filter((f) => f.checkId === 'config-name-unused').length, 0)
  const none = reconcile(sampleConfig(), { refs: [], filesScanned: 0 })
  assert.equal(none.filter((f) => f.checkId === 'config-name-unused').length, 11)
})

test('engine: duplicate name and port collision FAIL; distinct spaces do not collide', () => {
  const xml = `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173">
    <LynxModule name="CH" port="173">
      <Motor name="m1" port="0" /><Motor name="m1" port="1" />
      <Motor name="m2" port="1" /><Motor name="m3" port="1" />
      <Servo name="s1" port="1" />
    </LynxModule></LynxUsbDevice></Robot>`
  const findings = reconcile(parseConfigXml(xml), { refs: [], filesScanned: 0 })
  assert.ok(findings.some((f) => f.checkId === 'duplicate-name' && /m1/.test(f.message)))
  const collision = findings.find((f) => f.checkId === 'port-collision')
  assert.match(collision.message, /m2.*m3|m3.*m2/)
  assert.ok(!/s1/.test(collision.message), 'servo port 1 must not collide with motor port 1')
})

test('engine: dual default-address-2 hub trap FAILs with the factory-default callout', () => {
  const xml = `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="2">
    <LynxModule name="Hub A" port="2"><Motor name="a" port="0" /></LynxModule>
    <LynxModule name="Hub B" port="2"><Motor name="b" port="0" /></LynxModule>
  </LynxUsbDevice></Robot>`
  const f = reconcile(parseConfigXml(xml), { refs: [], filesScanned: 0 }).find((x) => x.checkId === 'hub-address-conflict')
  assert.match(f.message, /factory default/)
})

test('engine: name hygiene flags case/whitespace twins', () => {
  const xml = `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173">
    <LynxModule name="CH" port="173"><Motor name="Lift Motor" port="0" /><Motor name="liftmotor" port="1" /></LynxModule>
  </LynxUsbDevice></Robot>`
  const findings = reconcile(parseConfigXml(xml), { refs: [], filesScanned: 0 })
  assert.ok(findings.some((f) => f.checkId === 'name-hygiene'))
})

test('engine: drift detects hub swap, moved device, and removal with swap-recovery guidance', () => {
  const before = toSnapshot(sampleConfig())
  const after = toSnapshot(parseConfigXml(
    readFileSync(SAMPLE_XML, 'utf8')
      .replace('serialNumber="(embedded)"', 'serialNumber="DQ2FF00A"')
      .replace('<Motor name="arm_motor" port="2" />', '<Motor name="arm_motor" port="3" />')
      .replace('<ContinuousRotationServo name="intake" port="0" />', ''),
  ))
  const findings = diffSnapshot(before, after)
  assert.ok(findings.some((f) => /serial changed/.test(f.message) && /instead of SCANning/.test(f.fix)))
  assert.ok(findings.some((f) => /"arm_motor" moved/.test(f.message)))
  assert.ok(findings.some((f) => /removed since last PASS: "intake"/.test(f.message)))
})

test('engine: editDistance handles transpositions (wrsit→wrist = 1)', () => {
  assert.equal(editDistance('wrsit', 'wrist'), 1)
  assert.equal(editDistance('left_drive', 'left_drive'), 0)
})

test('report: markdown carries verdict, check versions, and evidence', () => {
  const findings = reconcile(sampleConfig(), { refs: [{ name: 'wrsit', file: 'T.java', line: 9 }], filesScanned: 1 })
  const md = renderMarkdown(findings, { deviceCount: 11, refCount: 1, filesScanned: 1 })
  assert.match(md, /# PHYSYNC preflight — FAIL/)
  assert.match(md, /code-name-missing v0\.1\.0/)
  assert.match(md, /T\.java:9/)
})

test('cli: end-to-end on samples — FAILs (exit 2) and names both planted bugs', () => {
  let out = ''
  try {
    execFileSync(process.execPath, ['bin/physync.js', 'check', '--config', 'samples/config.xml', '--code', 'samples/TeamCode'],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
    assert.fail('expected exit 2')
  } catch (e) {
    assert.equal(e.status, 2)
    out = e.stdout
  }
  assert.match(out, /FAIL/)
  assert.match(out, /wrsit/)
  assert.match(out, /did you mean "wrist"/)
  assert.match(out, /hang_motor/)
})

test('engine: clean config + fully matching code yields PASS', () => {
  const config = sampleConfig()
  const refs = config.devices.map((d) => ({ name: d.name, file: 'A.java', line: 1 }))
  const findings = reconcile(config, { refs, filesScanned: 1 })
  assert.equal(findings.filter((f) => f.severity === 'FAIL').length, 0)
  assert.equal(verdict(findings), 'PASS')
})
