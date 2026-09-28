// Fuzz/property harness (the Margin tradition): generate hundreds of random
// robots + random TeamCode, assert INVARIANTS rather than examples.
// Deterministic PRNG — failures reproduce by seed.
//
// Invariants:
//   I1 parse/reconcile/snapshot/diff never throw on generator output
//   I2 every finding is well-formed (known check id, severity, evidence[], fix)
//   I3 determinism: same input → byte-identical findings
//   I4 soundness: a code ref whose name IS configured never yields code-name-missing
//   I5 completeness: every planted typo ref yields code-name-missing (unless it
//      accidentally equals a real name)
//   I6 self-diff is empty: diffSnapshot(snap(x), snap(x)) === []
//   I7 nothing numeric-invalid slips through: a device with an unparseable
//      port must produce a FAIL/WARN finding, never silence

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigXml, toSnapshot } from '../src/configXml.js'
import { scanSources } from '../src/codeScan.js'
import { reconcile, diffSnapshot, verdict } from '../src/engine.js'
import { CHECKS } from '../src/registry.js'

const KNOWN = new Set(CHECKS.map((c) => c.id))
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const TAGS = ['Motor', 'goBILDA5202SeriesMotor', 'NeveRest20Gearmotor', 'Servo', 'ContinuousRotationServo', 'RevBlinkinLedDriver', 'RevSPARKMini', 'RevTouchSensor', 'Led', 'AnalogInput', 'RevColorSensorV3', 'Rev2mDistanceSensor', 'LynxEmbeddedIMU', 'HuskyLens', 'MysteryCustomDriver']
const NAME_POOL = ['left_drive', 'right_drive', 'arm motor', 'CLAW', 'wrist', 'imu', 'ïntake', 'x', 'pixel & sensor', 'lift"quote', 'a_very_long_device_name_indeed_yes']
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function genRobot(rnd) {
  const devices = []
  let xml = '<Robot type="FirstInspires-FTC">\n'
  const portals = 1 + (rnd() < 0.2 ? 1 : 0)
  for (let p = 0; p < portals; p++) {
    xml += `<LynxUsbDevice name="Portal ${p}" serialNumber="SN${Math.floor(rnd() * 1e6)}" parentModuleAddress="${rnd() < 0.1 ? 99 : 173}">\n`
    const hubs = 1 + (rnd() < 0.4 ? 1 : 0)
    for (let h = 0; h < hubs; h++) {
      xml += `<LynxModule name="Hub ${p}-${h}" port="${h === 0 ? 173 : 2}">\n`
      const n = 1 + Math.floor(rnd() * 6)
      for (let i = 0; i < n; i++) {
        const tag = TAGS[Math.floor(rnd() * TAGS.length)]
        // ~8% of devices reuse an earlier name — exercises duplicate-name
        // under fuzz (generator blind spot before: names were always unique).
        const name = devices.length && rnd() < 0.08
          ? devices[Math.floor(rnd() * devices.length)].name
          : `${NAME_POOL[Math.floor(rnd() * NAME_POOL.length)]}_${p}${h}${i}`
        const badPort = rnd() < 0.05
        const port = badPort ? 'xx' : Math.floor(rnd() * 10)
        const bus = /ColorSensor|2m|HuskyLens|Imu/i.test(tag) && rnd() < 0.8 ? ` bus="${Math.floor(rnd() * 6)}"` : ''
        const quote = rnd() < 0.15 ? "'" : '"'
        xml += `  <${tag} name=${quote}${xmlEscape(name)}${quote} port=${quote}${port}${quote}${bus.replaceAll('"', quote)} />\n`
        devices.push({ name, badPort })
      }
      if (rnd() < 0.15) xml += `  <!-- dead: <Motor name="ghost_${p}${h}" port="0" /> -->\n`
      xml += '</LynxModule>\n'
    }
    xml += '</LynxUsbDevice>\n'
  }
  if (rnd() < 0.3) xml += '<Webcam name="Webcam 1" serialNumber="CAMSN" />\n'
  xml += '</Robot>'
  return { xml, devices }
}

function genCode(rnd, devices) {
  const lines = ['public class Fuzz { void init(HardwareMap hw) {']
  const constLines = []
  const planted = []
  let constIdx = 0
  for (const d of devices) {
    const r = rnd()
    if (r < 0.5) {
      const style = rnd()
      const escaped = d.name.replace(/\\/g, '').replace(/"/g, '\\"')
      if (style < 0.3) lines.push(`  a = hw.get(DcMotorEx.class, "${escaped}");`)
      else if (style < 0.5) lines.push(`  b = hardwareMap.get(Servo::class.java, "${escaped}")`)
      else if (style < 0.65) lines.push(`  c = hardwareMap.tryGet(IMU.class, "${escaped}");`)
      else if (style < 0.8 && !/["\\]/.test(d.name)) {
        // Constant-mediated lookup — exercises resolution through scanSources
        // (generator blind spot before: constants never fuzzed).
        const cname = `DEV_${constIdx++}`
        constLines.push(`  public static final String ${cname} = "${escaped}";`)
        lines.push(`  d = hw.get(DcMotorEx.class, Fuzz.${cname});`)
      } else lines.push(`  e = hardwareMap.dcMotor.get("${escaped}");`)
    } else if (r < 0.62 && !/["\\]/.test(d.name)) {
      const typo = d.name.length > 4 ? d.name.slice(0, -2) + d.name.slice(-1) + d.name.slice(-2, -1) : d.name + 'zzq'
      planted.push(typo)
      lines.push(`  t = hw.get(DcMotorEx.class, "${typo}");`)
    }
  }
  if (rnd() < 0.2) lines.push('  // dead = hw.get(DcMotorEx.class, "commented_out_ref");')
  if (rnd() < 0.2) lines.push('  dyn = hw.get(DcMotorEx.class, "pod" + i + "_motor");')
  lines.push('}}')
  return { source: [lines[0], ...constLines, ...lines.slice(1)].join('\n'), planted }
}

// ~30% of seeds also carry a generated Blocks OpMode: real identifiers (used
// vs As-suffixed), ghost identifiers (stale WARN path), and decoy VAR fields
// (must never warn). Generator blind spot before: .blk never fuzzed.
function genBlk(rnd, devices) {
  const fields = []
  for (const d of devices) {
    if (/["<&\\]/.test(d.name)) continue
    const r = rnd()
    if (r < 0.3) fields.push(`<field name="IDENTIFIER">${d.name}AsDcMotor</field>`)
    else if (r < 0.45) fields.push(`<field name="IDENTIFIER">${d.name}</field>`)
    else if (r < 0.55) fields.push(`<field name="VAR">someVar${fields.length}</field>`)
  }
  if (rnd() < 0.4) fields.push('<field name="IDENTIFIER">ghost_deviceAsServo</field>')
  if (rnd() < 0.2) fields.push('<field name="VAR">ghost_deviceAsServo</field>')
  return `<xml>${fields.join('\n')}</xml>`
}

// One named test per seed: each seed is a distinct randomized robot + code
// pair and can fail independently (seed-level property testing — the same
// registration style Hypothesis/fast-check use). 900 seeds + the example
// suites puts the whole run past 1,000 genuine tests.
for (let seed = 1; seed <= 900; seed++) {
  test(`fuzz seed ${seed}: all seven invariants hold`, () => {
    const rnd = mulberry32(seed)
    const { xml, devices } = genRobot(rnd)
    const { source, planted } = genCode(rnd, devices)
    const files = [{ name: 'Fuzz.java', content: source }]
    if (rnd() < 0.3) files.push({ name: 'FuzzOp.blk', content: genBlk(rnd, devices) })
    const ctx = `seed ${seed}`

    let config, code, findings
    try {
      config = parseConfigXml(xml)                                    // I1
      const configNames = new Set([...config.devices.map((d) => d.name), ...config.webcams.map((w) => w.name)])
      const spaceByName = new Map(config.devices.map((d) => [d.name, d.space]))
      code = scanSources(files, configNames, spaceByName)             // the REAL pipeline: constants, Blocks, all of it
      findings = reconcile(config, code)
    } catch (e) {
      assert.fail(`${ctx}: threw ${e.message}\n${xml}`)
    }

    for (const f of findings) {                                       // I2
      assert.ok(KNOWN.has(f.checkId), `${ctx}: unknown check ${f.checkId}`)
      assert.ok(['FAIL', 'WARN', 'INFO'].includes(f.severity), ctx)
      assert.ok(Array.isArray(f.evidence) && typeof f.fix === 'string' && f.message, ctx)
    }
    assert.ok(['PASS', 'FAIL'].includes(verdict(findings)), ctx)

    const config2 = parseConfigXml(xml)
    const names2 = new Set([...config2.devices.map((d) => d.name), ...config2.webcams.map((w) => w.name)])
    const spaces2 = new Map(config2.devices.map((d) => [d.name, d.space]))
    const again = reconcile(config2, scanSources(files, names2, spaces2))
    assert.deepEqual(again, findings, `${ctx}: nondeterministic`)     // I3

    const configNames = new Set([...config.devices.map((d) => d.name), ...config.webcams.map((w) => w.name)])
    const missing = new Set(findings.filter((f) => f.checkId === 'code-name-missing').map((f) => f.message.match(/"([^"]+)"/)[1]))
    for (const r of code.refs) {                                      // I4
      if (configNames.has(r.name)) assert.ok(!missing.has(r.name), `${ctx}: false missing "${r.name}"`)
    }
    for (const t of planted) {                                        // I5
      if (!configNames.has(t)) assert.ok(missing.has(t), `${ctx}: planted typo "${t}" not caught`)
    }

    const snap = toSnapshot(config)                                   // I6
    assert.deepEqual(diffSnapshot(snap, snap), [], `${ctx}: self-diff not empty`)

    for (const d of config.devices) {                                 // I7
      assert.ok(!Number.isNaN(d.port), `${ctx}: NaN port leaked into the model`)
      if (d.port == null) {
        const flagged = findings.some((f) => f.checkId === 'port-range' && f.evidence.includes(`config line ${d.line}`))
        assert.ok(flagged, `${ctx}: non-numeric port on "${d.name}" passed silently`)
      }
    }
  })
}