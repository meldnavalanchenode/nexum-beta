// One regression test per defect class from the adversarial QA fleet
// (32 defects: port-space misclassification, XML naivety, scanner evasion,
// missing physical validation, CLI crash paths). A wrong PASS is the worst
// failure this tool can have — these lock the fixes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfigXml, portSpace, toSnapshot } from '../src/configXml.js'
import { scanJavaSource, collectConstants } from '../src/codeScan.js'
import { reconcile, diffSnapshot, verdict } from '../src/engine.js'

const APP = new URL('..', import.meta.url).pathname
const wrap = (devices) => `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173">${devices}</LynxModule></LynxUsbDevice></Robot>`
const run = (config, refs = []) => reconcile(parseConfigXml(config), { refs, dynamic: [], filesScanned: 1 })

test('P0: Blinkin is a servo-port device — collides with a Servo, not with digital', () => {
  assert.equal(portSpace('RevBlinkinLedDriver', {}), 'servo')
  const collide = run(wrap('<Servo name="claw" port="2" /><RevBlinkinLedDriver name="lights" port="2" />'))
  assert.ok(collide.some((f) => f.checkId === 'port-collision'), 'servo+blinkin same port must FAIL')
  const legal = run(wrap('<RevBlinkinLedDriver name="lights" port="3" /><RevTouchSensor name="arm_limit" port="3" />'))
  assert.ok(!legal.some((f) => f.checkId === 'port-collision'), 'blinkin(servo 3) vs touch(digital 3) is legal')
})

test('P0: SPARKMini classified servo; unknown tags surfaced instead of silently exempted', () => {
  assert.equal(portSpace('RevSPARKMini', {}), 'servo')
  const collide = run(wrap('<RevSPARKMini name="intake" port="4" /><Servo name="claw" port="4" />'))
  assert.ok(collide.some((f) => f.checkId === 'port-collision'))
  const unknown = run(wrap('<MysteryCustomDriver name="thing" port="0" />'))
  assert.ok(unknown.some((f) => f.checkId === 'unknown-device-type'))
})

test('P0: XML comments are dead — commented-out device does not mask a missing name', () => {
  const config = wrap('<!-- removed: <Motor name="arm_motor" port="2" /> --><Motor name="lift" port="0" />')
  const findings = run(config, [{ name: 'arm_motor', file: 'T.java', line: 5 }])
  assert.ok(findings.some((f) => f.checkId === 'code-name-missing' && /arm_motor/.test(f.message)))
  assert.equal(parseConfigXml(config).devices.length, 1)
})

test('P0: single-quoted attributes parse (legal XML the RC accepts)', () => {
  const m = parseConfigXml(wrap(`<goBILDA5202SeriesMotor name='right_drive' port='0' /><Motor name="left_drive" port="0" />`))
  assert.equal(m.devices.length, 2)
  const findings = reconcile(m, { refs: [], dynamic: [], filesScanned: 0 })
  assert.ok(findings.some((f) => f.checkId === 'port-collision'), 'both motors on port 0 must collide')
})

test('P1: XML entities decoded — "arm &amp; claw" matches code\'s "arm & claw"', () => {
  const m = parseConfigXml(wrap('<Motor name="arm &amp; claw motor" port="0" />'))
  assert.equal(m.devices[0].name, 'arm & claw motor')
  const findings = reconcile(m, { refs: [{ name: 'arm & claw motor', file: 'T.java', line: 1 }], dynamic: [], filesScanned: 1 })
  assert.ok(!findings.some((f) => f.checkId === 'code-name-missing'))
})

test('P1: out-of-range ports and buses FAIL', () => {
  const findings = run(wrap('<Motor name="m" port="7" /><Servo name="s" port="9" /><RevColorSensorV3 name="c" port="0" bus="6" />'))
  assert.equal(findings.filter((f) => f.checkId === 'port-range').length, 3)
  assert.equal(verdict(findings), 'FAIL')
})

test('P1: duplicate identical I2C sensors on one bus FAIL; different models on one bus pass', () => {
  const dup = run(wrap('<RevColorSensorV3 name="c1" port="1" bus="2" /><RevColorSensorV3 name="c2" port="2" bus="2" />'))
  assert.ok(dup.some((f) => f.checkId === 'i2c-address-conflict'))
  const mixed = run(wrap('<RevColorSensorV3 name="c1" port="1" bus="2" /><Rev2mDistanceSensor name="d1" port="2" bus="2" />'))
  assert.ok(!mixed.some((f) => f.checkId === 'i2c-address-conflict'))
})

test('P1: touch sensor pair-port overlap WARNs', () => {
  const findings = run(wrap('<RevTouchSensor name="limit" port="1" /><Led name="indicator" port="0" />'))
  assert.ok(findings.some((f) => f.checkId === 'digital-pair-overlap'))
})

test('P1: parentModuleAddress pointing at no declared hub FAILs', () => {
  const xml = '<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="2"><LynxModule name="Hub" port="3"><Motor name="m" port="0" /></LynxModule></LynxUsbDevice></Robot>'
  assert.ok(run(xml).some((f) => f.checkId === 'parent-address-mismatch'))
})

test('P1: webcams get duplicate-name and unused checks; header counts them', () => {
  const xml = '<Robot type="FirstInspires-FTC"><Webcam name="Webcam 1" serialNumber="A" /><Webcam name="Webcam 1" serialNumber="B" /></Robot>'
  const findings = reconcile(parseConfigXml(xml), { refs: [], dynamic: [], filesScanned: 0 })
  assert.ok(findings.some((f) => f.checkId === 'duplicate-name' && /Webcam 1/.test(f.message)))
  assert.ok(findings.some((f) => f.checkId === 'config-name-unused' && /Webcam 1/.test(f.message)))
})

test('P0: wrapper-class receivers caught — hw.get(DcMotorEx.class, "x") counts', () => {
  const out = scanJavaSource('public void init(HardwareMap hw) { m = hw.get(DcMotorEx.class, "left_dirve"); }', 'RobotHardware.java')
  assert.equal(out.refs.length, 1)
  assert.equal(out.refs[0].name, 'left_dirve')
})

test('P0: constants resolved across files — typo in a constant is caught', () => {
  const constants = collectConstants('public static final String LEFT = "left_dirve";')
  const out = scanJavaSource('m = hardwareMap.get(DcMotorEx.class, DriveConstants.LEFT);', 'T.java', constants)
  assert.equal(out.refs[0].name, 'left_dirve')
  assert.match(out.refs[0].via, /const/)
})

test('P0: Kotlin ::class.java form caught', () => {
  const out = scanJavaSource('val lift = hardwareMap.get(DcMotorEx::class.java, "lift_motr")', 'Lift.kt')
  assert.equal(out.refs[0].name, 'lift_motr')
})

test('P1: comments stripped — dead lookups produce no refs; dynamic names reported not guessed', () => {
  const out = scanJavaSource([
    '// old = hardwareMap.get(DcMotor.class, "old_arm");',
    '/* legacy = hardwareMap.get(DcMotor.class, "legacy_arm"); */',
    'live = hardwareMap.get(DcMotor.class, "arm_motor");',
    'pod = hardwareMap.get(DcMotor.class, "module" + i + "_motor");',
  ].join('\n'), 'CleanTeleOp.java')
  assert.deepEqual(out.refs.map((r) => r.name), ['arm_motor'])
  assert.equal(out.dynamic.length, 1)
  assert.match(out.dynamic[0].expr, /module/)
  const findings = reconcile(parseConfigXml(wrap('<Motor name="arm_motor" port="0" />')), { refs: out.refs, dynamic: out.dynamic, filesScanned: 1 })
  assert.ok(!findings.some((f) => f.checkId === 'code-name-missing'), 'no false FAIL from comments or concat fragments')
  assert.ok(findings.some((f) => f.checkId === 'dynamic-name'))
})

test('P1: drift catches a device TYPE change (motor model swap)', () => {
  const before = toSnapshot(parseConfigXml(wrap('<goBILDA5202SeriesMotor name="ld" port="0" />')))
  const after = toSnapshot(parseConfigXml(wrap('<goBILDA5201SeriesMotor name="ld" port="0" />')))
  const findings = diffSnapshot(before, after)
  assert.ok(findings.some((f) => /changed type/.test(f.message)))
})

test('engine: no absurd did-you-mean on very short names', () => {
  const findings = run(wrap('<Motor name="b" port="0" />'), [{ name: 'a', file: 'T.java', line: 1 }])
  const missing = findings.find((f) => f.checkId === 'code-name-missing')
  assert.ok(!/did you mean/.test(missing.message))
})

test('cli: non-FTC XML, corrupted snapshot, and --code-as-file all die cleanly (exit 1, no stack)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-'))
  const tryRun = (cliArgs, cwd = dir) => {
    try {
      execFileSync(process.execPath, [join(APP, 'bin/physync.js'), ...cliArgs], { cwd, encoding: 'utf8', stdio: 'pipe' })
      return { status: 0, err: '' }
    } catch (e) { return { status: e.status, err: String(e.stderr) } }
  }
  writeFileSync(join(dir, 'server.xml'), '<network><listener name="http" port="8080"/></network>')
  const notFtc = tryRun(['check', '--config', 'server.xml', '--code', '.'])
  assert.equal(notFtc.status, 1)
  assert.match(notFtc.err, /does not look like an FTC robot configuration/)
  assert.ok(!/at .*\.js:\d/.test(notFtc.err), 'no stack trace')

  writeFileSync(join(dir, 'config.xml'), wrap('<Motor name="m" port="0" />'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, '.physync/snapshot.json'), '{"portals": [truncated')
  const badSnap = tryRun(['diff', '--config', 'config.xml'])
  assert.equal(badSnap.status, 1)
  assert.match(badSnap.err, /Snapshot .* unreadable/)

  const codeAsFile = tryRun(['check', '--config', 'config.xml', '--code', 'config.xml'])
  assert.equal(codeAsFile.status, 1)
  assert.match(codeAsFile.err, /must be a directory/)

  const emptySnap = tryRun(['snapshot', '--config', 'server.xml'])
  assert.equal(emptySnap.status, 1)
})

test('blocks: matched identifiers credit unused-check; stale ones WARN, never FAIL', async () => {
  const { scanBlkSource } = await import('../src/codeScan.js')
  const categorize2 = (xml) => parseConfigXml(xml)
  const blk = [
    '<xml><block type="dcMotor_setProperty_Number">',
    '<field name="IDENTIFIER">left_driveAsDcMotor</field>',
    '<field name="PROP">Power</field><field name="VAR">myCounter</field>',
    '<field name="IDENTIFIER">clawAsServo</field>',
    '<field name="IDENTIFIER">old_armAsDcMotor</field>',
    '<field name="IDENTIFIER">imu</field>',
    '</block></xml>',
  ].join('\n')
  const names = new Set(['left_drive', 'claw', 'imu'])
  const out = scanBlkSource(blk, 'TeleOp.blk', names)
  assert.deepEqual(out.refs.map((r) => r.name).sort(), ['claw', 'imu', 'left_drive'])
  assert.equal(out.unknown.length, 1)
  assert.equal(out.unknown[0].base, 'old_arm')

  const model = categorize2(wrap('<Motor name="left_drive" port="0" /><Servo name="claw" port="0" /><LynxEmbeddedIMU name="imu" port="0" bus="0" />'))
  const findings = reconcile(model, { refs: out.refs, dynamic: [], blocksUnknown: out.unknown, filesScanned: 0 })
  const blocksWarn = findings.find((f) => f.checkId === 'blocks-name-unknown')
  assert.ok(blocksWarn && blocksWarn.severity === 'WARN')
  assert.ok(!findings.some((f) => f.checkId === 'config-name-unused'), 'blocks refs must credit the unused check')
  assert.ok(!findings.some((f) => f.checkId === 'code-name-missing'), 'blocks evidence must never produce a FAIL')
})

test('hard-test: markdown report escapes hostile content (FOUND lesson applied)', async () => {
  const { renderMarkdown } = await import('../src/report.js')
  const findings = [{ checkId: 'code-name-missing', checkVersion: '0.1.0', severity: 'FAIL', message: 'Code expects "<script>alert(1)</script>" — not found', evidence: ['T.java:1'], fix: 'fix | this' }]
  const md = renderMarkdown(findings, { deviceCount: 1, refCount: 1, filesScanned: 1 })
  assert.ok(!md.includes('<script>'), 'HTML must be escaped in the report')
  assert.ok(md.includes('fix \\| this'), 'pipes must be escaped')
})

test('hard-test: --json output is deterministic (no timestamp) and --report still writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-ci-'))
  writeFileSync(join(dir, 'config.xml'), wrap('<Motor name="m" port="0" />'))
  mkdirSync(join(dir, 'code'))
  writeFileSync(join(dir, 'code/T.java'), 'a = hardwareMap.get(DcMotor.class, "m");')
  const runJson = () => execFileSync(process.execPath, [join(APP, 'bin/physync.js'), 'check', '--config', 'config.xml', '--code', 'code', '--json', '--report', 'out.md'], { cwd: dir, encoding: 'utf8' })
  const a = runJson()
  const b = runJson()
  assert.equal(a, b, 'identical inputs must produce byte-identical JSON')
  const parsed = JSON.parse(a)
  assert.equal(parsed.physync, 1)
  assert.equal(parsed.verdict, 'PASS')
  assert.ok(!('timestamp' in parsed.context))
  assert.ok(readFileSync(join(dir, 'out.md'), 'utf8').includes('PHYSYNC preflight'), '--report must write alongside --json')
})

test('hard-test: Blockly variable named like an identifier produces NO stale-identifier WARN', async () => {
  const { scanBlkSource } = await import('../src/codeScan.js')
  const blk = '<xml><field name="VAR">countAsDcMotor</field><field name="IDENTIFIER">old_armAsDcMotor</field></xml>'
  const out = scanBlkSource(blk, 'T.blk', new Set(['left_drive']))
  assert.equal(out.unknown.length, 1, 'only the IDENTIFIER field warns')
  assert.equal(out.unknown[0].base, 'old_arm')
})

test('hard-test: constants resolve across files through scanSources', async () => {
  const { scanSources } = await import('../src/codeScan.js')
  const out = scanSources([
    { name: 'Constants.java', content: 'public static final String LEFT = "left_dirve";' },
    { name: 'TeleOp.java', content: 'm = hardwareMap.get(DcMotorEx.class, Constants.LEFT);' },
  ], new Set())
  assert.equal(out.refs.length, 1)
  assert.equal(out.refs[0].name, 'left_dirve')
})

test('R3-P0: constant collisions are order-independent — local definition wins, cross-file conflict falls to dynamic', async () => {
  const { scanSources } = await import('../src/codeScan.js')
  const bop = { name: 'BOp.java', content: 'public static final String CLAW = "missing_servo"; s = hardwareMap.get(Servo.class, CLAW);' }
  const zother = { name: 'ZOther.java', content: 'public static final String CLAW = "arm";' }
  for (const order of [[bop, zother], [zother, bop]]) {
    const out = scanSources(order, new Set(['arm']))
    assert.deepEqual(out.refs.map((r) => r.name), ['missing_servo'], 'file-local constant must win in both orders')
  }
  // No local definition + conflicting cross-file values → ambiguous → dynamic
  const user = { name: 'User.java', content: 's = hardwareMap.get(Servo.class, Constants.CLAW);' }
  const out = scanSources([bop, zother, user], new Set(['arm']))
  const userRefs = out.refs.filter((r) => r.file === 'User.java')
  assert.equal(userRefs.length, 0, 'conflicted constant must not resolve')
  assert.ok(out.dynamic.some((d) => d.file === 'User.java'), 'conflicted constant surfaces as dynamic')
})

test('R3-P1: Blocks VAR field before IDENTIFIER field no longer suppresses the stale WARN', async () => {
  const { scanBlkSource } = await import('../src/codeScan.js')
  const blk = '<xml><field name="VAR">ghostAsDcMotor</field><field name="IDENTIFIER">ghostAsDcMotor</field></xml>'
  const out = scanBlkSource(blk, 'T.blk', new Set(['left_drive']))
  assert.equal(out.unknown.length, 1)
  assert.equal(out.unknown[0].base, 'ghost')
})

test('R3-P2: Blocks type-mismatch (armAsDcMotor vs configured Servo) WARNs but still credits usage', async () => {
  const { scanBlkSource } = await import('../src/codeScan.js')
  const spaces = new Map([['arm', 'servo']])
  const out = scanBlkSource('<xml><field name="IDENTIFIER">armAsDcMotor</field></xml>', 'T.blk', new Set(['arm']), spaces)
  assert.deepEqual(out.refs.map((r) => r.name), ['arm'], 'usage still credited')
  assert.equal(out.unknown.length, 1)
  assert.equal(out.unknown[0].kind, 'type-mismatch')
  const findings = reconcile(parseConfigXml(wrap('<Servo name="arm" port="0" />')), { refs: out.refs, dynamic: [], blocksUnknown: out.unknown, filesScanned: 0 })
  const warn = findings.find((f) => f.checkId === 'blocks-name-unknown')
  assert.ok(warn && warn.severity === 'WARN' && /servo side/.test(warn.message))
  assert.ok(!findings.some((f) => f.checkId === 'config-name-unused'))
})

test('R3: walker survives unreadable subdirs and symlink cycles without crashes or rescans', async () => {
  const { scanCodeDir } = await import('../src/codeScan.js')
  const { symlinkSync, chmodSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'physync-walk-'))
  writeFileSync(join(dir, 'Op.java'), 'm = hardwareMap.get(DcMotor.class, "m");')
  mkdirSync(join(dir, 'secret'))
  chmodSync(join(dir, 'secret'), 0o000)
  symlinkSync(dir, join(dir, 'self'))
  let out
  try {
    out = scanCodeDir(dir, new Set(['m']))
  } finally {
    chmodSync(join(dir, 'secret'), 0o755)
  }
  assert.equal(out.filesScanned, 1, 'symlink cycle must not rescan')
  assert.equal(out.refs.length, 1)
  assert.ok(out.unreadable.includes('secret'), 'unreadable dir surfaced, not crashed')
})

test('AI assist: prompt builder is pure and complete; explainFindings never throws and never touches the verdict path', async () => {
  const { buildExplainPrompt, explainFindings } = await import('../src/assist.js')
  const findings = [{ checkId: 'code-name-missing', severity: 'FAIL', message: 'Code expects "x"', evidence: ['T.java:3'], fix: 'Rename it.' }]
  const prompt = buildExplainPrompt({ verdict: 'FAIL', findings, context: { deviceCount: 2, refCount: 1, filesScanned: 1 } })
  assert.ok(prompt.includes('Preflight verdict: FAIL') && prompt.includes('T.java:3') && prompt.includes('Rename it.'))

  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-invalid-test-key'
  try {
    const result = await explainFindings({ verdict: 'FAIL', findings, context: { deviceCount: 2, refCount: 1, filesScanned: 1 } })
    assert.equal(result.ok, false, 'bogus key must degrade, not succeed')
    assert.equal(typeof result.reason, 'string')
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
})

// ── Fleet round 4: stimulus / sensors / servo / integration ─────────────────
test('R4-P0: an empty or fully-interrupted stimulus report can never PASS', async () => {
  const { parseStimulusReport, analyzeStimulus } = await import('../src/stimulus.js')
  for (const raw of ['{"physyncStimulus":1}', '{"physyncStimulus":1,"motors":[],"servos":[],"skipped":[]}']) {
    const f = analyzeStimulus(parseStimulusReport(raw))
    assert.ok(f.some((x) => x.checkId === 'stimulus-nothing-verified'), 'empty report must not be silent')
    assert.equal(verdict(f), 'FAIL')
  }
  const allInterrupted = parseStimulusReport('{"physyncStimulus":1,"motors":[{"name":"a","deltaTicks":0,"result":"interrupted"}],"servos":[],"skipped":[]}')
  assert.equal(verdict(analyzeStimulus(allInterrupted)), 'FAIL', 'a run where nothing completed is not a pass')
})

test('R4-P0: a servo in the baseline but absent from the run FAILs, exactly like a motor', async () => {
  const { parseStimulusReport, diffStimulus } = await import('../src/stimulus.js')
  const baseline = { motors: [{ name: 'm', direction: 'positive' }], servos: [{ name: 'claw' }] }
  const f = diffStimulus(baseline, parseStimulusReport('{"physyncStimulus":1,"motors":[{"name":"m","deltaTicks":90,"result":"moved-positive"}],"servos":[],"skipped":[]}'))
  assert.ok(f.some((x) => x.checkId === 'stimulus-response-lost' && /claw/.test(x.message)))
  assert.equal(verdict(f), 'FAIL')
})

test('R4-P1: a baseline device whose test was interrupted is reported as NOT COMPARED, not silently passed', async () => {
  const { parseStimulusReport, diffStimulus } = await import('../src/stimulus.js')
  const baseline = { motors: [{ name: 'm', direction: 'positive' }], servos: [] }
  const f = diffStimulus(baseline, parseStimulusReport('{"physyncStimulus":1,"motors":[{"name":"m","deltaTicks":0,"result":"interrupted"}],"servos":[],"skipped":[]}'))
  assert.ok(f.some((x) => x.checkId === 'stimulus-not-compared'))
  assert.equal(verdict(f), 'FAIL')
})

test('R4-P1: a self-contradictory stimulus result is rejected rather than half-believed', async () => {
  const { parseStimulusReport, analyzeStimulus } = await import('../src/stimulus.js')
  const f = analyzeStimulus(parseStimulusReport('{"physyncStimulus":1,"motors":[{"name":"m","deltaTicks":-9999,"result":"moved-positive"}],"servos":[],"skipped":[]}'))
  assert.ok(f.some((x) => x.checkId === 'stimulus-report-inconsistent'))
  assert.equal(verdict(f), 'FAIL')
})

test('R4-P1: a malformed stimulus baseline is rejected loudly, never used to emit "undefined" findings', async () => {
  const { validateStimulusBaseline } = await import('../src/stimulus.js')
  assert.throws(() => validateStimulusBaseline({ motors: [{ name: 'm' }] }), /no usable direction/)
  assert.throws(() => validateStimulusBaseline({ motors: [] }), /records no motors/)
  assert.throws(() => validateStimulusBaseline({ motors: [{}] }), /no name/)
  assert.throws(() => validateStimulusBaseline(null), /not a baseline object/)
})

test('R4-P0: servo binding reused for two devices in one file disables neither check', async () => {
  const { scanServoUsage } = await import('../src/codeScan.js')
  const src = [
    'void initIntake() { Servo s = hardwareMap.get(Servo.class, "intake"); s.setPosition(1.4); }',
    'void initClaw() { Servo s = hardwareMap.get(Servo.class, "claw"); s.setPosition(0.5); }',
  ].join('\n')
  const out = scanServoUsage(src, 'T.java')
  assert.equal(out.calls.length, 0, 'an ambiguous variable must not be resolved to the last binding')
  assert.ok(out.unresolved.length >= 1, 'and the ambiguity must be reported, not silent')
})

test('R4-P0: nested-call arguments do not leak into the range check (no false FAIL on Range.scale)', async () => {
  const { scanServoUsage } = await import('../src/codeScan.js')
  const out = scanServoUsage('Servo wrist = hardwareMap.get(Servo.class, "wrist");\nwrist.setPosition(Range.scale(v, -1, 1, 0.2, 0.8));', 'T.java')
  assert.equal(out.calls.length, 1)
  assert.deepEqual(out.calls[0].args, [null], 'the whole nested expression is one unresolvable argument')
})

test('R4-P0: Kotlin typed val and Java this.field bindings are traced', async () => {
  const { scanServoUsage } = await import('../src/codeScan.js')
  const kt = scanServoUsage('val claw: Servo = hardwareMap.get(Servo::class.java, "claw")\nclaw.setPosition(1.4)', 'T.kt')
  assert.equal(kt.calls[0]?.device, 'claw', 'typed val must bind the variable, not the type')
  const field = scanServoUsage('void init() { this.claw = hardwareMap.get(Servo.class, "claw"); }\nvoid go() { claw.setPosition(1.4); }', 'T.java')
  assert.equal(field.calls[0]?.device, 'claw', 'the official FTC hardware-class pattern must be traced')
})

test('R4-P0: qualified constants resolve to their own class, and d/f-suffixed names still resolve', async () => {
  const { scanServoUsage, collectNumericConstants } = await import('../src/codeScan.js')
  const consts = new Map([['Claw.HOME', 0.5], ['Winch.HOME', 2.75], ['HOME', 0.5], ['CLAW_CLOSED', 1.9]])
  const out = scanServoUsage('Servo claw = hardwareMap.get(Servo.class, "claw");\nclaw.setPosition(Claw.HOME);\nclaw.setPosition(CLAW_CLOSED);', 'T.java', consts)
  assert.equal(out.calls[0].args[0], 0.5, 'Claw.HOME must not pick up Winch.HOME')
  assert.equal(out.calls[1].args[0], 1.9, 'a name ending in D must not be mangled by the float-suffix stripper')
  const m = collectNumericConstants('class Claw { public static final double HOME = 0.5; }')
  assert.equal(m.get('Claw.HOME'), 0.5)
})

test('R4-P1: a servo call inside a string literal is not a finding', async () => {
  const { scanServoUsage } = await import('../src/codeScan.js')
  const out = scanServoUsage('Servo claw = hardwareMap.get(Servo.class, "claw");\nString s = "claw.setPosition(1.4)";', 'T.java')
  assert.equal(out.calls.length, 0)
})

test('R4-P0: sensor livenessDeterminable fails closed and hub pins can never FAIL', async () => {
  const { parseRobotReport, analyzeSensors } = await import('../src/sensors.js')
  assert.throws(() => parseRobotReport('{"physyncRobot":1,"sensors":[{"name":"imu","class":"i2c","read":"error"}]}'), /boolean livenessDeterminable/)
  const pin = parseRobotReport('{"physyncRobot":1,"sensors":[{"name":"t","class":"digital","read":"error","livenessDeterminable":true}]}')
  assert.equal(verdict(analyzeSensors(pin)), 'PASS', 'a hub pin must never reach FAIL, whatever the report claims')
})

test('R4-P1: diff uses the shared verdict — WARN-only drift exits PASS like check does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-r4-'))
  writeFileSync(join(dir, 'a.xml'), wrap('<Motor name="m" port="0" /><Servo name="s" port="0" />'))
  writeFileSync(join(dir, 'b.xml'), wrap('<Motor name="m" port="0" /><Servo name="s" port="1" />'))
  const run = (a) => { try { execFileSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }); return 0 } catch (e) { return e.status } }
  assert.equal(run(['snapshot', '--config', 'a.xml']), 0)
  assert.equal(run(['diff', '--config', 'b.xml']), 0, 'a WARN-only drift is not a FAIL')
})

test('R4-P1: an unknown flag is an error, not silently ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-r4f-'))
  writeFileSync(join(dir, 'stim.json'), '{"physyncStimulus":1,"motors":[{"name":"m","deltaTicks":90,"result":"moved-positive"}],"servos":[],"skipped":[]}')
  try {
    execFileSync(process.execPath, [join(APP, 'bin/physync.js'), 'stimulus', '--file', 'stim.json', '--basline'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    assert.fail('a misspelled --baseline must not silently run a no-baseline comparison')
  } catch (e) {
    assert.equal(e.status, 1)
    assert.match(String(e.stderr), /Unknown flag/)
  }
})
