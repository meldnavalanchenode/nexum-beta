// THE ON-ROBOT CONTRACT.
//
// Two halves that have never met: PhysyncPreflight.java runs on a Control Hub
// and writes physync-robot.json; sensors.js reads it on a laptop. The Java has
// never been compiled in this repo — there is no gradle project — let alone
// run on hardware. Every fixture we test against was AUTHORED to match the
// parser, which proves the parser reads our own files and nothing else.
//
// What can be checked without a robot is that the two halves still agree on
// the wire format. These tests read the Java's literal format strings and the
// parser's accepted values and assert they match, so a change to either side
// cannot silently break every team who runs the OpMode.
//
// They do NOT prove the OpMode compiles, runs, or produces correct readings.
// Nothing here is evidence about hardware.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRobotReport, analyzeSensors } from '../src/sensors.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const JAVA = readFileSync(join(APP, 'robot/PhysyncPreflight.java'), 'utf8')
const PARSER = readFileSync(join(APP, 'src/sensors.js'), 'utf8')

const setFrom = (name) => {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(PARSER)
  assert.ok(m, `${name} not found in sensors.js`)
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}

test('every read result the OpMode can emit is one the parser accepts', () => {
  const accepted = setFrom('READS')
  // `new Liveness("<class>", "<result>", …)` — the second argument is the read.
  const emitted = new Set([...JAVA.matchAll(/new Liveness\("[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]))
  assert.ok(emitted.size >= 3, `expected several read results in the Java, found ${[...emitted]}`)
  const rejected = [...emitted].filter((r) => !accepted.has(r))
  assert.deepEqual(rejected, [],
    `the OpMode emits read result(s) the laptop will refuse: ${rejected.join(', ')} (accepted: ${[...accepted].join(', ')})`)
})

test('every sensor class the OpMode can emit is one the parser accepts', () => {
  const accepted = setFrom('CLASSES')
  const emitted = new Set([...JAVA.matchAll(/new Liveness\("([^"]+)"/g)].map((m) => m[1]))
  const rejected = [...emitted].filter((c) => !accepted.has(c))
  assert.deepEqual(rejected, [],
    `the OpMode emits sensor class(es) the laptop will refuse: ${rejected.join(', ')} (accepted: ${[...accepted].join(', ')})`)
})

test('the OpMode emits every field the parser requires', () => {
  // The parser throws by name on each of these; a dropped field bricks the
  // report for every team at once.
  for (const field of ['physyncRobot', 'name', 'type', 'class', 'read', 'value', 'livenessDeterminable', 'address']) {
    assert.ok(JAVA.includes(`\\"${field}\\"`), `the OpMode never writes "${field}", which the parser requires`)
  }
})

test('a report built from the Java\'s own format strings parses and judges correctly', () => {
  // Assembled from the literal formats in PhysyncPreflight.java, NOT from a
  // fixture — a fixture only proves the parser reads files we wrote for it.
  const report = {
    physyncRobot: 1,
    hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.74 }],
    devices: [{ name: 'left_drive', type: 'DcMotorImplEx', connection: 'USB 1; port 0' }],
    sensors: [
      { name: 'imu', type: 'LynxEmbeddedIMU', class: 'i2c', read: 'ok', value: 'yaw=0.4', livenessDeterminable: true },
      { name: 'front_dist', type: 'Rev2mDistanceSensor', class: 'i2c', read: 'error', value: 'NullPointerException', livenessDeterminable: true },
      { name: 'touch', type: 'RevTouchSensor', class: 'digital', read: 'ok', value: 'released', livenessDeterminable: false },
    ],
    deviceCount: 1, sensorCount: 3,
    fingerprints: [{ id: 'imu-gravity', method: 'imu-gravity-rest', values: { pitchDeg: 0.412, rollDeg: -0.118 } }],
  }
  const parsed = parseRobotReport(JSON.stringify(report))
  assert.equal(parsed.sensors.length, 3)
  const findings = analyzeSensors(parsed)
  const fail = findings.filter((f) => f.severity === 'FAIL')
  assert.equal(fail.length, 1, 'the dead distance sensor is the one failure')
  assert.match(fail[0].message, /front_dist/)
  // A sensor whose liveness cannot be determined must never be scored as alive.
  assert.ok(!findings.some((f) => f.severity === 'FAIL' && /touch/.test(f.message)),
    'a non-determinable sensor is not a failure — it is absence of evidence')
})

test('the report path degrades instead of failing to compile', () => {
  // A phone Robot Controller on Android 11+ enforces scoped storage and a raw
  // FileWriter("/sdcard/...") throws. The SDK knows the right location, but
  // IMPORTING its class would turn a missing class into a COMPILE error on a
  // team's machine — the one failure they cannot debug. Reflection keeps the
  // file compiling either way.
  assert.match(JAVA, /Class\.forName\("org\.firstinspires\.ftc\.robotcore\.internal\.system\.AppUtil"\)/,
    'the SDK location should be resolved at runtime')
  assert.ok(!/^\s*import\s+org\.firstinspires\.ftc\.robotcore\.internal\.system\.AppUtil;/m.test(JAVA),
    'and must NOT be imported — a missing class would break the build, not degrade')
  assert.match(JAVA, /return "\/sdcard\/FIRST\/physync-robot\.json"/, 'with the documented path as fallback')
})

test('the driver station never claims a report was saved when it was not', () => {
  // A team staring at the Driver Station has no other feedback channel. The
  // card used to print the path unconditionally, so a failed write still
  // showed "Report → /sdcard/FIRST/..." and they went looking for a file that
  // was never there.
  assert.match(JAVA, /reportWrittenTo != null/, 'the card branches on the real outcome')
  assert.match(JAVA, /Report NOT saved/, 'and says so plainly when the write failed')
})

test('every on-robot source is syntactically parseable', () => {
  // Not a compile — the FTC SDK is not here. This only catches the class of
  // error that would stop a team's Android Studio build before it even
  // resolves imports. Brace and paren balance is a crude but real check that
  // an edit did not truncate or unbalance the file.
  for (const f of readdirSync(join(APP, 'robot')).filter((x) => x.endsWith('.java'))) {
    const src = readFileSync(join(APP, 'robot', f), 'utf8')
    const bal = (open, close) => [...src].reduce((n, c) => n + (c === open ? 1 : c === close ? -1 : 0), 0)
    assert.equal(bal('{', '}'), 0, `${f}: unbalanced braces`)
    assert.equal(bal('(', ')'), 0, `${f}: unbalanced parens`)
    assert.ok(/\bclass\s+\w+/.test(src), `${f}: no class declaration`)
  }
})
