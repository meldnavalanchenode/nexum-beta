#!/usr/bin/env node
// NEXUM CLI — thin route layer; all logic in src/.
//   physync check --config <config.xml> --code <TeamCodeDir> [--report out.md]
//   physync snapshot --config <config.xml>       record the current PASS state
//   physync diff --config <config.xml>           what changed since the snapshot
//   physync pull [--host 192.168.43.1:5555]      pull configs off the hub via adb
// Exit codes: 0 PASS · 1 could not run · 2 FAIL (CI-able).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseConfigXml, toSnapshot } from '../src/configXml.js'
import { scanCodeDir } from '../src/codeScan.js'
import { reconcile, diffSnapshot, verdict } from '../src/engine.js'
import { basename } from 'node:path'
import { renderTerminal, renderMarkdown } from '../src/report.js'
import { ENGINE_VERSION } from '../src/registry.js'
import { parseStimulusReport, toStimulusBaseline, analyzeStimulus, diffStimulus, validateStimulusBaseline } from '../src/stimulus.js'
import { parseRobotReport, toSensorBaseline, analyzeSensors, diffSensors, validateSensorBaseline } from '../src/sensors.js'
import { buildApproval, validateApproval, compareApproval, verifyManifestHmac, newGateKey } from '../src/approval.js'
import { checkMeta } from '../src/registry.js'
import { buildVerifiedState, saveState, listStates, latestState, nextVersion, migrateLegacy, detectChanges, deploymentStatus, statusExitCode, STATUSES, rederivedFrom } from '../src/state.js'
import { loadGraph, saveGraph, validateEdge, effectiveEdges } from '../src/graph.js'
import { plan, APPLICABILITY } from '../src/planner.js'
import { loadReported, recordReported, reportedSince, asChange } from '../src/reported.js'
import { predict, markRevealed, debrief, assignVerdict, closeExperiment, openExperiment, listExperiments } from '../src/experiment.js'
import { loadTests, saveTests, validateTestDef, appendResult, loadResults, latestResults, detectRegressions, TESTS_FILE } from '../src/results.js'
import { loadFingerprintDefs } from '../src/fingerprints.js'
import { parseInventory, toStateDevices } from '../src/inventory.js'
import { RULE_PACKS, packEdges } from '../src/packs.js'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = args[i + 1]
  if (value == null || value.startsWith('--')) die(`--${name} needs a value.\n${usage}`)
  return value
}
const usage = `usage:
  physync init  --config <config.xml> --code <TeamCodeDir> --by <yourName>   ← START HERE (one-time setup)
  physync check --config <config.xml> --code <TeamCodeDir> [--report out.md] [--json]
  physync explain --config <config.xml> --code <TeamCodeDir>   (check + AI explanation; needs credentials + internet)
  physync snapshot --config <config.xml>
  physync diff --config <config.xml>
  physync sensors  --file <physync-robot.json> [--baseline] [--json]
  physync stimulus --file <physync-stimulus.json> [--baseline] [--json]
  physync approve  --config <config.xml> --code <TeamCodeDir> [--robot <physync-robot.json>] [--name <activeConfigName>] [--force] [--json]
  physync gate     --config <config.xml> [--file <physync-robot.json>] [--approval <path>] [--json]
  physync state    --config <config.xml> --code <TeamCodeDir> [--robot <r.json>] [--stimulus <s.json>] [--json]   (save verified state VN — append-only)
  physync state    --declare <inventory.json> [--stimulus <s.json>] [--json]   (non-FTC robots: baseline from a HAND-DECLARED device list — no reconciliation)
  physync states   [--json]                                    (list verified state history)
  physync status   --config <config.xml> --code <TeamCodeDir> [--robot <r.json>] [--json]   (vs latest state → changes, invalidated evidence, minimum revalidation; exit 0/2/3)
  physync status   --declare <inventory.json> [--json]         (same, for a hand-declared robot)
  physync rules    [--pack <name>] [--by <humanName>] [--json]  (list rule packs; --pack loads one as PROPOSED edges, inert until approved)
  physync change   --component <node-id> --note <text> --by <name>                         (record a PHYSICAL change no file records — self-reported, never a detection)
  physync change   --list                                                                  (list self-reported changes)
  physync graph    [--json]                                    (list dependency edges: built-in + custom + proposed)
  physync graph --propose --from <node> --to <node> [--note <why>]   (store a PROPOSED edge — never affects decisions until approved)
  physync graph --approve <edgeId> --by <humanName>            (a named human makes a proposed edge real)
  physync tests    [--define --id <id> --kind validation|robustness --label <text> [--min <n>] [--max <n>] --by <human>] [--json]
  physync result   --test <id> [--value <n>] [--pass|--fail|--unknown] [--evidence <text>] [--notes <text>] --by <human>
  physync results  [--test <id>] [--json]                      (result history + regression detection)
  physync predict  --checks "a, b, c" [--note <text>] --by <name>   (SHADOW MODE: record your plan BEFORE seeing Nexum's — immutable once revealed)
  physync debrief  --checked "a, b" [--notes <text>] --by <name>    (after the work: what actually happened; deltas computed, never a verdict)
  physync verdict  --verdict HELPED|"NO VALUE"|"EXTRA WORK"|MISSED|AMBIGUOUS --basis <protocol rule> --by <name>
  physync experiment [--json]                                  (list shadow-mode records)
  physync pull [--host 192.168.43.1:5555] [--out pulled/]`
function die(msg) { console.error(msg); process.exit(1) }

// An unsupported Node is the likeliest way a remote first-run dies, and the
// native error ("Unexpected token", a syntax error deep in a module) names
// nothing a student can act on. Say the actual problem, once, in their words.
{
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isFinite(major) && major < 20) {
    console.error(`\n  Nexum needs Node 20 or newer — this is Node ${process.versions.node}.`)
    console.error('  Install the LTS build from https://nodejs.org (it replaces this one safely),')
    console.error('  reopen your terminal, and check with:  node --version')
    console.error('  Nothing else about your setup needs to change.\n')
    process.exit(1)
  }
}

// Carefully-worded integrity messages used to reach the user as a raw Node
// stack trace: the ledger loader throws, nothing catches it, and ONE damaged
// file under .physync took down every command — including the ones that could
// have dug the team out. A beta tester seeing an ES-module traceback concludes
// the tool is broken, which is both bad and, in the recovery case, wrong.
process.on('uncaughtException', (err) => {
  const msg = err?.message ?? String(err)
  console.error(`\n  Nexum stopped: ${msg}\n`)
  if (/integrity check|not a physync state|unsupported state format|ledger line|must be \{/.test(msg)) {
    console.error('  A file under .physync is damaged or was edited by hand. Your ROBOT is fine —')
    console.error('  this is only Nexum\'s own record. To see which file and recover:')
    console.error('    ls .physync/states                 # the versions on record')
    console.error('    mv .physync .physync-broken        # set the whole record aside, then')
    console.error('    node app/bin/physync.js state --config <xml> --code <dir>   # start a fresh V1')
    console.error('  Please send us .physync-broken (states + results only, no source code) — a')
    console.error('  damaged ledger is a bug on our side, not yours.\n')
  } else if (err?.code === 'ENOENT') {
    console.error('  A file Nexum expected is not there. Check the path you passed, or re-run')
    console.error('  `node app/bin/physync.js init --config <xml> --code <dir> --by <you>`.\n')
  } else if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EROFS') {
    console.error('  Nexum could not write to this folder. Run it from a directory you own.\n')
  } else {
    console.error('  That is an unhandled error — a bug worth reporting. Send us the command you')
    console.error('  ran and this message; nothing in your verified history has been changed.\n')
  }
  process.exit(1)
})

const KNOWN_FLAGS = {
  check: ['config', 'code', 'report', 'json'],
  explain: ['config', 'code'],
  snapshot: ['config'],
  diff: ['config', 'json'],
  sensors: ['file', 'baseline', 'json'],
  stimulus: ['file', 'baseline', 'json'],
  approve: ['config', 'code', 'robot', 'name', 'force', 'json'],
  gate: ['config', 'file', 'approval', 'json'],
  state: ['config', 'code', 'robot', 'stimulus', 'declare', 'json'],
  states: ['json'],
  status: ['config', 'code', 'robot', 'declare', 'json', 'reveal'],
  rules: ['pack', 'by', 'json'],
  change: ['component', 'note', 'by', 'list', 'json'],
  graph: ['propose', 'from', 'to', 'note', 'approve', 'by', 'json'],
  tests: ['define', 'id', 'kind', 'label', 'min', 'max', 'by', 'json'],
  result: ['test', 'value', 'pass', 'fail', 'unknown', 'evidence', 'notes', 'by', 'method', 'simulated'],
  results: ['test', 'json'],
  predict: ['checks', 'note', 'by', 'abandon', 'json'],
  debrief: ['checked', 'notes', 'by', 'json'],
  verdict: ['verdict', 'basis', 'by', 'json'],
  experiment: ['json'],
  init: ['config', 'code', 'by', 'pack', 'json'],
  pull: ['host', 'out'],
}

// Remembered inputs — after the first explicit run, `status`/`state` work
// with no flags. Friction at the exact moment a robot just changed is the
// product's enemy; UNKNOWN-by-absence is always preferred over demanding
// full configuration, and reuse is always announced, never silent.
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')
const INPUTS_FILE = '.physync/inputs.json'
const recallInputs = () => { try { return JSON.parse(readFileSync(INPUTS_FILE, 'utf8')) } catch { return {} } }
const rememberInputs = (o) => { try { mkdirSync('.physync', { recursive: true }); writeFileSync(INPUTS_FILE, JSON.stringify(o, null, 2)) } catch { /* memory is a convenience, never a failure */ } }
const reuseRememberedInputs = () => {
  if (opt('declare') || opt('config')) return
  const rem = recallInputs()
  if (!rem.config) return
  const reused = []
  // ONLY config and code: those are re-READ from disk every run, so reusing
  // the path re-derives nothing — it just saves typing. A --robot or
  // --stimulus file is a MEASUREMENT of a moment, and replaying the one that
  // produced the baseline made that baseline's own evidence count as freshly
  // re-established: rechecks silently vanished and a stale row was labelled
  // RE-DERIVED. A measurement is never remembered; it must be taken again.
  const moved = []
  for (const k of ['config', 'code']) {
    if (opt(k)) continue
    if (rem[k] && existsSync(rem[k])) { args.push(`--${k}`, rem[k]); reused.push(`--${k} ${rem[k]}`) }
    else if (rem[k]) moved.push([k, rem[k]])
  }
  if (reused.length) console.log(`  (using remembered inputs: ${reused.join(' · ')} — pass flags to override)`)
  // A remembered path that no longer resolves used to fall through to a
  // 25-line usage dump — in the exact mid-panic moment the zero-flag command
  // exists to serve. Say what moved, and what to type.
  if (moved.length) {
    console.error(`\n  Nexum remembered ${moved.map(([k, p]) => `--${k} ${p}`).join(' and ')}, but ${moved.length > 1 ? 'those paths are' : 'that path is'} no longer there.`)
    console.error('  Files get moved and renamed — nothing is wrong with your robot or your history.')
    console.error(`  Run it once with the current path and Nexum will remember the new one:`)
    console.error(`    node app/bin/physync.js ${cmd} ${moved.map(([k]) => `--${k} <path>`).join(' ')}\n`)
    process.exit(1)
  }
}

/** The code's git state, when the code dir is a repo — honest null otherwise. */
const gitStateOf = (dir) => {
  if (!dir) return null
  try {
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
    return { sha, dirty }
  } catch { return null }
}
// A misspelled flag is silently ignored by every naive CLI, which is how a user
// ends up believing they recorded a baseline they did not.
for (const a of args.slice(1)) {
  if (!a.startsWith('--')) continue
  const name = a.slice(2).split('=')[0]
  const known = KNOWN_FLAGS[cmd] ?? []
  if (!known.includes(name)) {
    die(`Unknown flag "${a}" for \`physync ${cmd}\`. Valid: ${known.map((f) => '--' + f).join(', ') || '(none)'}\n${usage}`)
  }
}

const SNAPSHOT = '.physync/snapshot.json'
const STIMULUS_BASELINE = '.physync/stimulus-baseline.json'
const SENSOR_BASELINE = '.physync/sensor-baseline.json'
const APPROVED = '.physync/approved.json'
const GATE_KEY = '.physync/gate.key'

const loadConfig = () => {
  const path = opt('config') ?? die(usage)
  let model
  try {
    model = parseConfigXml(readFileSync(path, 'utf8'))
  } catch (e) {
    die(`Cannot read config: ${e.message}`)
  }
  if (!model.isFtcConfig) {
    die(`${path} does not look like an FTC robot configuration (no <Robot> root) — point --config at the active configuration XML from /sdcard/FIRST/.`)
  }
  return model
}

const loadSnapshot = () => {
  try {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    if (!Array.isArray(snap.portals) || !Array.isArray(snap.devices)) throw new Error('wrong shape')
    return snap
  } catch (e) {
    die(`Snapshot ${SNAPSHOT} is unreadable (${e.message}) — delete it and run \`physync snapshot\` again after your next verified PASS.`)
  }
}

// Shared check pipeline — used by `check` and `explain`.
function runCheck() {
  const config = loadConfig()
  const codeDir = opt('code') ?? die(usage)
  if (!existsSync(codeDir)) die(`Code directory not found: ${codeDir}`)
  if (!statSync(codeDir).isDirectory()) die(`--code must be a directory (got a file): ${codeDir}`)
  if (config.devices.length === 0 && config.webcams.length === 0) die('No devices found in that config XML — is it the active configuration file?')
  const configNames = new Set([...config.devices.map((d) => d.name), ...config.webcams.map((w) => w.name)])
  const spaceByName = new Map(config.devices.map((d) => [d.name, d.space]))
  const code = scanCodeDir(codeDir, configNames, spaceByName)
  if (code.refs.length === 0) {
    const hint = code.filesScanned === 0
      ? (code.blkCount > 0 ? `${code.blkCount} Blocks (.blk) files scanned (identifier matching only).` : 'No Java/Kotlin sources found.')
      : 'Sources found but no hardwareMap lookups recognized — unusual patterns? Config-side checks still ran.'
    console.error(`⚠ No device references extracted. ${hint}`)
  }
  if (code.unreadable.length) console.error(`⚠ Could not read: ${code.unreadable.join(', ')}`)

  const findings = reconcile(config, code)
  if (existsSync(SNAPSHOT)) findings.push(...diffSnapshot(loadSnapshot(), toSnapshot(config)))
  // No timestamp in context: identical inputs must produce byte-identical
  // output (--json feeds CI caching and artifact diffing).
  const context = {
    deviceCount: config.devices.length,
    webcamCount: config.webcams.length,
    refCount: code.refs.length,
    filesScanned: code.filesScanned,
    blkCount: code.blkCount,
    codeDigest: code.codeDigest,
    engineVersion: ENGINE_VERSION,
  }
  return { findings, context }
}

if (cmd === 'init') {
  // ONE command that gets a team from "cloned the repo" to "ready to run the
  // loop". Before this existed, the documented path produced "0 recheck(s)
  // owed" — honest, and useless — because a team had no tests defined and no
  // dependency rules approved, so there was nothing to reason about. Six
  // undocumented commands stood between a new user and the product working.
  //
  // It is deliberately NOT magic: it scaffolds CANDIDATES and prints exactly
  // what a human must still decide. It approves nothing on anyone's behalf.
  const by = opt('by') ?? die('physync init needs --by <yourName> — setup decisions carry the name of whoever made them.')
  const configPath = opt('config') ?? die('physync init needs --config <yourconfig.xml> (pull it from the Robot Controller: /sdcard/FIRST/*.xml)')
  const codeDir = opt('code') ?? die('physync init needs --code <YourTeamCodeFolder>')
  if (!existsSync(configPath)) die(`Config not found: ${configPath}`)
  if (!existsSync(codeDir)) die(`TeamCode folder not found: ${codeDir}`)
  const packName = opt('pack') ?? 'camera-pose'

  mkdirSync('.physync', { recursive: true })
  // Opt-in marker: this project is running the shadow-mode experiment, so
  // status will hold its answer until a prediction is on record.
  writeFileSync('.physync/beta.json', JSON.stringify({ experiment: 'shadow-mode', by, at: new Date().toISOString() }, null, 2))
  const notes = []

  // 1 · tests.json — a starting vocabulary of checks a team actually runs.
  // Thresholds are left UNSET on purpose: a threshold is an engineering
  // decision with an author, and we are not that author.
  if (existsSync(TESTS_FILE)) {
    notes.push(`tests already defined (${loadTests('.').length}) — left alone`)
  } else {
    saveTests([
      { id: 'drive-straight', kind: 'validation', label: 'robot drives straight over a set distance' },
      { id: 'localization', kind: 'validation', label: 'robot knows where it is on the field' },
      { id: 'camera-pose', kind: 'validation', label: 'camera pose calibration' },
    ], '.')
    notes.push('3 starter checks defined in .physync/tests.json (rename/add/remove freely)')
  }

  // 2 · candidate dependency rules — PROPOSED, inert, awaiting a human.
  let proposed = 0
  try {
    const g = loadGraph('.')
    const existing = new Set(g.custom.map((e) => `${e.from}→${e.to}`))
    const fresh = packEdges(packName).filter((e) => !existing.has(`${e.from}→${e.to}`))
    if (fresh.length) {
      for (const e of fresh) validateEdge({ ...e, proposedAt: new Date().toISOString() }, { requireApproved: false })
      saveGraph([...g.custom, ...fresh.map((e) => ({ ...e, proposedAt: new Date().toISOString() }))])
    }
    proposed = fresh.length
  } catch (e) { die(`Could not load rule pack "${packName}": ${e.message}`) }

  console.log(`\n  NEXUM is set up for this robot.  (by ${by})\n`)
  for (const n of notes) console.log(`    · ${n}`)
  console.log(`    · ${proposed} candidate dependency rule(s) from the "${packName}" pack — PROPOSED, and they do NOTHING yet`)
  console.log('\n  ONE DECISION IS YOURS — Nexum will not make it for you:')
  console.log('  A dependency rule says "if X changes, re-check Y". Nexum does not know')
  console.log('  whether that is true of YOUR robot, so every rule stays inert until')
  console.log('  someone on your team approves it by name:\n')
  const g2 = loadGraph('.')
  for (const e of g2.custom.filter((e) => e.status === 'proposed')) {
    console.log(`    ${e.from} → ${e.to}`)
    console.log(`      physync graph --approve ${e.id} --by ${by}`)
  }
  console.log('\n  THEN, the beta loop (4 commands, in this order):')
  console.log(`    1. physync state --config ${configPath} --code ${codeDir}     ← freeze today's robot as V1`)
  console.log('    2. physync predict --checks "a, b" --by <name>   ← BEFORE a change: what YOU would re-check')
  console.log('    3. physync status                                ← AFTER the change: what Nexum says')
  console.log('    4. physync debrief --checked "a, b" --by <name>  ← what you actually did')
  console.log('\n  Step 2 matters most: it must happen BEFORE step 3, or the comparison is lost.\n')
  process.exit(0)
}

if (cmd === 'check') {
  const { findings, context } = runCheck()
  const reportPath = opt('report')
  if (reportPath) {
    try {
      writeFileSync(reportPath, renderMarkdown(findings, context))
    } catch (e) {
      console.error(`⚠ Could not write report: ${e.message}`)
    }
  }
  // --json: machine-readable output for CI gates (the enterprise thesis in
  // miniature — same schema the deployment gate will speak).
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, verdict: verdict(findings), context, findings }, null, 2))
    process.exit(verdict(findings) === 'PASS' ? 0 : 2)
  }
  console.log(renderTerminal(findings, context))
  process.exit(verdict(findings) === 'PASS' ? 0 : 2)
}

if (cmd === 'explain') {
  // Deterministic verdict FIRST — the AI layer is advisory only and can
  // never touch it. AI failure changes nothing, including the exit code.
  const { findings, context } = runCheck()
  const v = verdict(findings)
  console.log(renderTerminal(findings, context))
  const { explainFindings } = await import('../src/assist.js')
  const { sanitizeBlock } = await import('../src/text.js')
  const result = await explainFindings({ verdict: v, findings, context })
  console.log('  ── ADVISORY (AI) — explanation only, not part of the verdict ──')
  // Model output is untrusted too (it may echo scanned strings): control
  // bytes are neutralized before the terminal sees them.
  console.log(result.ok ? sanitizeBlock(result.text).split('\n').map((l) => `  ${l}`).join('\n') : `  ${result.reason}`)
  console.log('')
  process.exit(v === 'PASS' ? 0 : 2)
}

if (cmd === 'sensors') {
  const file = opt('file') ?? die(`sensors needs --file <physync-robot.json>\n${usage}`)
  let report
  try {
    report = parseRobotReport(readFileSync(file, 'utf8'))
  } catch (e) {
    die(`Cannot read robot report: ${e.message}`)
  }
  if (args.includes('--baseline')) {
    const answering = report.sensors.filter((s) => s.determinable && s.read === 'ok').length
    if (answering === 0) {
      die('Refusing to record a baseline in which no I2C sensor answered — nothing would be verifiable against it. (Digital and analog pins are excluded by design: their liveness cannot be determined.)')
    }
    mkdirSync('.physync', { recursive: true })
    const written = toSensorBaseline(report)
    writeFileSync(SENSOR_BASELINE, JSON.stringify(written, null, 2))
    if (args.includes('--json')) {
      console.log(JSON.stringify({ physync: 1, action: 'baseline-recorded', kind: 'sensors', recorded: written.sensors.length, path: SENSOR_BASELINE }, null, 2))
    } else {
      console.log(`Sensor baseline recorded: ${answering} answering I2C sensor(s) → ${SENSOR_BASELINE}`)
      console.log('Record this only from a robot you have verified by hand — every later run is judged against it.')
    }
    process.exit(0)
  }
  let findings
  if (existsSync(SENSOR_BASELINE)) {
    let baseline
    try {
      baseline = validateSensorBaseline(JSON.parse(readFileSync(SENSOR_BASELINE, 'utf8')))
    } catch (e) {
      die(`Sensor baseline ${SENSOR_BASELINE} is unreadable (${e.message}) — delete it and re-record with --baseline.`)
    }
    findings = diffSensors(baseline, report)
  } else {
    console.error('⚠ No sensor baseline yet — reporting this run only. Record one from a hand-verified robot with --baseline to enable change detection.')
    findings = analyzeSensors(report)
  }
  const context = { deviceCount: report.sensors.length, webcamCount: 0, refCount: 0, filesScanned: 0, mode: 'sensors', comparedToBaseline: existsSync(SENSOR_BASELINE), engineVersion: ENGINE_VERSION }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, verdict: verdict(findings), context, findings }, null, 2))
    process.exit(verdict(findings) === 'PASS' ? 0 : 2)
  }
  console.log(renderTerminal(findings, context))
  process.exit(verdict(findings) === 'PASS' ? 0 : 2)
}

if (cmd === 'stimulus') {
  const file = opt('file') ?? die(`stimulus needs --file <physync-stimulus.json>\n${usage}`)
  let report
  try {
    report = parseStimulusReport(readFileSync(file, 'utf8'))
  } catch (e) {
    die(`Cannot read stimulus report: ${e.message}`)
  }
  const tested = report.motors.length + report.servos.length
  if (args.includes('--baseline')) {
    if (report.aborted) die('Refusing to record a baseline from an aborted pass — re-run the stimulus pass to completion on a robot you have verified by hand.')
    const responsive = report.motors.filter((m) => m.result.startsWith('moved')).length
    if (responsive === 0) die('Refusing to record a baseline in which no motor responded — nothing would be verifiable against it.')
    // Overwriting a richer baseline with a thinner one silently flips real
    // FAILs to PASS on every device that disappears, so it must be a decision,
    // not a side effect.
    if (existsSync(STIMULUS_BASELINE)) {
      try {
        const prior = validateStimulusBaseline(JSON.parse(readFileSync(STIMULUS_BASELINE, 'utf8')))
        const lost = prior.motors.filter((m) => !report.motors.some((r) => r.name === m.name && r.result.startsWith('moved'))).map((m) => m.name)
        if (lost.length) {
          die(`Refusing to overwrite the existing baseline: it verifies ${lost.join(', ')}, which this pass did not. Recording it would silently stop checking ${lost.length === 1 ? 'that device' : 'those devices'}. Delete ${STIMULUS_BASELINE} first if that is genuinely what you want.`)
        }
      } catch (e) {
        if (!/Refusing/.test(e.message)) console.error(`⚠ Existing baseline unreadable (${e.message}) — replacing it.`)
      }
    }
    mkdirSync('.physync', { recursive: true })
    const written = toStimulusBaseline(report)
    writeFileSync(STIMULUS_BASELINE, JSON.stringify(written, null, 2))
    if (args.includes('--json')) {
      console.log(JSON.stringify({ physync: 1, action: 'baseline-recorded', kind: 'stimulus', motors: written.motors.length, servos: written.servos.length, path: STIMULUS_BASELINE }, null, 2))
    } else {
      console.log(`Stimulus baseline recorded: ${responsive} responding motor(s), ${report.servos.filter((s) => s.confirmed).length} confirmed servo(s) → ${STIMULUS_BASELINE}`)
      console.log('Record this only from a robot you have verified by hand — every later run is judged against it.')
    }
    process.exit(0)
  }
  let findings
  if (existsSync(STIMULUS_BASELINE)) {
    let baseline
    try {
      baseline = validateStimulusBaseline(JSON.parse(readFileSync(STIMULUS_BASELINE, 'utf8')))
    } catch (e) {
      die(`Stimulus baseline ${STIMULUS_BASELINE} is unreadable (${e.message}) — delete it and re-record with --baseline.`)
    }
    findings = diffStimulus(baseline, report)
  } else {
    console.error('⚠ No stimulus baseline yet — reporting this run only. Record one from a hand-verified robot with --baseline to enable change detection.')
    findings = analyzeStimulus(report)
  }
  const context = { deviceCount: tested, webcamCount: 0, refCount: 0, filesScanned: 0, mode: 'stimulus', comparedToBaseline: existsSync(STIMULUS_BASELINE), engineVersion: ENGINE_VERSION }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, verdict: verdict(findings), context, findings }, null, 2))
    process.exit(verdict(findings) === 'PASS' ? 0 : 2)
  }
  console.log(renderTerminal(findings, context))
  process.exit(verdict(findings) === 'PASS' ? 0 : 2)
}

if (cmd === 'approve') {
  // Approval means "tested and approved": the state must PASS the full check
  // pipeline right now, or there is nothing here worth freezing.
  const { findings, context } = runCheck()
  if (verdict(findings) === 'FAIL') {
    console.log(renderTerminal(findings, context))
    die('Refusing to approve a FAILING state — fix the findings above first. Approval is a record that a human verified this robot, not a way to silence the check.')
  }
  const configPath = opt('config')
  // Raw BYTES for hashing — utf8-decoding first collapsed invalid bytes to
  // U+FFFD and produced a demonstrated wrong PASS on a byte-changed config.
  const configBytes = readFileSync(configPath)
  const configXml = configBytes.toString('utf8')
  // The name the ROBOT enforces is the ACTIVE configuration name on the
  // Driver Station — which equals the hub-side filename, not whatever this
  // laptop copy happens to be called. A renamed download ("robot (1).xml")
  // would bake in a name the robot can never match: a guaranteed false
  // refusal. --name overrides; a suspicious basename gets a loud warning.
  const derivedName = basename(configPath).replace(/\.xml$/i, '')
  const configName = opt('name') ?? derivedName
  if (!opt('name') && /\(\d+\)| copy$|^copy /i.test(derivedName)) {
    console.error(`⚠ Config name recorded as "${derivedName}" — that looks like a duplicated download, not the name on the hub. If the active configuration on the Driver Station is called something else, re-run with --name <thatName>, or the on-robot gate will refuse a healthy robot.`)
  }

  let hubs = []
  let hubsVerified = false
  const robotPath = opt('robot')
  if (robotPath) {
    let robot
    try {
      robot = parseRobotReport(readFileSync(robotPath, 'utf8'))
    } catch (e) {
      die(`Cannot read robot report: ${e.message}`)
    }
    if (!Array.isArray(robot.hubs) || robot.hubs.length === 0) {
      die('That robot report contains no hub census — re-run the PHYSYNC Preflight OpMode and pull a fresh physync-robot.json.')
    }
    // "Tested and approved" cannot mean "while holding a report that shows
    // the robot broken." If the very report supplying the hub census carries
    // failing sensors, approval is refused until the robot is actually fixed.
    const health = analyzeSensors(robot)
    if (verdict(health) === 'FAIL') {
      const failing = health.filter((f) => f.severity === 'FAIL').map((f) => f.message)
      die(`Refusing to approve: the robot report you supplied shows failures —\n  ${failing.join('\n  ')}\nFix the robot (or re-run the preflight if this is stale), then approve.`)
    }
    hubs = robot.hubs.map((h) => ({ address: h.address, firmware: String(h.firmware ?? '') }))
    hubsVerified = true
  }

  // Provenance, not a metaphor: record which code was approved.
  const codeDir = opt('code')
  let codeGitSha = null
  let codeGitDirty = null
  try {
    codeGitSha = execFileSync('git', ['-C', codeDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    codeGitDirty = execFileSync('git', ['-C', codeDir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
  } catch { /* not a git repo — recorded as unknown, never guessed */ }

  if (existsSync(APPROVED) && !args.includes('--force')) {
    let prior = null
    try { prior = JSON.parse(readFileSync(APPROVED, 'utf8')) } catch { /* unreadable prior — still require --force */ }
    die(`An approval already exists${prior?.createdAt ? ` (recorded ${prior.createdAt})` : ''}. Replacing it re-baselines the gate — pass --force if this robot has been re-verified by hand.`)
  }

  mkdirSync('.physync', { recursive: true })
  let key
  if (existsSync(GATE_KEY)) {
    key = readFileSync(GATE_KEY, 'utf8').trim()
    // An empty or mangled key file used to slip through as falsy and write a
    // silently UNSIGNED manifest — success banner and all. Corrupt key, loud stop.
    if (!/^[0-9a-f]{64}$/.test(key)) {
      die(`Gate key at ${GATE_KEY} is corrupt (not 64 hex chars). Delete it and approve again — a fresh key will be generated, and previously signed approvals will need re-approving.`)
    }
  } else {
    key = newGateKey()
    writeFileSync(GATE_KEY, key, { mode: 0o600 })
  }

  const manifest = buildApproval({
    configName, configXml: configBytes, hubs, hubsVerified,
    devices: parseConfigXml(configXml).devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus ?? null })),
    codeGitSha, codeGitDirty, engineVersion: ENGINE_VERSION, key,
  })
  writeFileSync(APPROVED, JSON.stringify(manifest, null, 2))

  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, action: 'approved', configName, hubsVerified, hubs: manifest.hubs, stateDigest: manifest.stateDigest, codeGitSha, codeGitDirty, path: APPROVED }, null, 2))
    process.exit(0)
  }
  console.log(`Approved: config "${configName}" (${manifest.devices.length} devices)${hubsVerified ? `, ${hubs.length} hub(s) with firmware` : ' — declaration layer only (no --robot report)'} → ${APPROVED}`)
  if (codeGitSha) console.log(`Code at approval: ${codeGitSha.slice(0, 12)}${codeGitDirty ? ' (working tree DIRTY — the approved code may not be committed)' : ''}`)
  if (!hubsVerified) console.log('To extend the gate to the physical layer: run the Preflight OpMode, then re-approve with --robot physync-robot.json.')
  console.log(`To arm the on-robot gate: adb push ${APPROVED} /sdcard/FIRST/physync-approved.json`)
  process.exit(0)
}

if (cmd === 'gate') {
  const approvalPath = opt('approval', APPROVED)
  const gateFindings = []
  const mkFinding = (id, message, evidence, fix) => {
    const meta = checkMeta(id)
    return { checkId: id, checkVersion: meta.version, severity: meta.severity, message, evidence, fix }
  }

  let approval = null
  if (!existsSync(approvalPath)) {
    gateFindings.push(mkFinding('approval-missing', `No approval on record at ${approvalPath}`, [],
      'Verify the robot by hand, then run `physync approve`. The gate fails closed: no approval means nothing to compare, and nothing to compare is not a PASS.'))
  } else {
    try {
      approval = validateApproval(JSON.parse(readFileSync(approvalPath, 'utf8')))
    } catch (e) {
      approval = null
      gateFindings.push(mkFinding('approval-missing', `Approval at ${approvalPath} is unreadable or corrupted: ${e.message}`, [],
        'The gate fails closed on a manifest that cannot prove its own integrity. Re-verify the robot and run `physync approve` again.'))
    }
  }

  if (approval) {
    if (existsSync(GATE_KEY)) {
      const key = readFileSync(GATE_KEY, 'utf8').trim()
      if (!/^[0-9a-f]{64}$/.test(key)) {
        die(`Gate key at ${GATE_KEY} is corrupt (not 64 hex chars). Delete it and re-approve to regenerate.`)
      }
      if (!verifyManifestHmac(approval, key)) {
        gateFindings.push(mkFinding('approval-bad-signature', 'Approval signature does not verify with this laptop\'s gate key', [],
          'This manifest was not signed by this laptop (or the key changed). If the approval is legitimate, re-approve here; provenance only, not a safety claim.'))
      }
    } else {
      // A tampered manifest with honestly recomputed digests sails through
      // digest self-consistency; only the HMAC catches it, and with no key
      // that check silently didn't happen. That gap must be IN the verdict
      // output, not buried on stderr.
      gateFindings.push(mkFinding('approval-signature-unverified', 'No gate key on this laptop — approval provenance NOT verified (digest self-consistency only)', [],
        'Run the gate on the laptop that approved (it holds .physync/gate.key), or accept that this manifest could have been rewritten by anyone with a copy of physync.'))
    }

    const configPath = opt('config') ?? die(`gate needs --config <config.xml> — the currently active configuration to compare against the approval.\n${usage}`)
    let configBytes
    try {
      configBytes = readFileSync(configPath)
    } catch (e) {
      die(`Cannot read config: ${e.message}`)
    }
    const configName = basename(configPath).replace(/\.xml$/i, '')

    let hubs = null
    const filePath = opt('file')
    if (filePath) {
      try {
        hubs = parseRobotReport(readFileSync(filePath, 'utf8')).hubs.map((h) => ({ address: h.address, firmware: String(h.firmware ?? '') }))
      } catch (e) {
        die(`Cannot read robot report: ${e.message}`)
      }
      // The verdict is exactly as fresh as this file. PHYSYNC cannot know
      // when it was written (the hub has no trustworthy clock), so it says
      // so instead of implying a live reading.
      console.error('⚠ Verdict is as of the moment that robot report was written — for a fresh verdict, re-run the Preflight OpMode and pull a fresh physync-robot.json.')
    } else if (approval.hubsVerified) {
      // Fail closed, loudly: an approval that covers hubs cannot be "checked"
      // while silently skipping the hub half.
      die('This approval covers the hub layer — pass --file <physync-robot.json> from a fresh preflight run so the gate can actually check it. Checking half an approval and rendering a verdict would be a green light over a gap.')
    }

    gateFindings.push(...compareApproval(approval, { configName, configXml: configBytes, hubs }, checkMeta))
  }

  const context = {
    deviceCount: approval?.devices?.length ?? 0, webcamCount: 0, refCount: 0, filesScanned: 0,
    mode: 'gate', approvedAt: approval?.createdAt ?? 'never', hubsVerified: approval?.hubsVerified ?? false,
    engineVersion: ENGINE_VERSION,
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, verdict: verdict(gateFindings), context, findings: gateFindings }, null, 2))
    process.exit(verdict(gateFindings) === 'PASS' ? 0 : 2)
  }
  console.log(renderTerminal(gateFindings, context))
  process.exit(verdict(gateFindings) === 'PASS' ? 0 : 2)
}

if (cmd === 'state') {
  reuseRememberedInputs()
  // Save the next verified state — append-only, never overwrites history.
  //
  // Two doors in. --config is the FTC one: a real configuration file off a real
  // hub, reconciled against real source. --declare is for every robot PHYSYNC
  // cannot read a configuration from (VEX V5 among them): a person writes down
  // what is on the robot, and that list is recorded as a person's claim. The
  // second door never borrows the first's evidence.
  const declarePath = opt('declare')
  let inventory = null
  if (declarePath) {
    if (opt('config') || opt('code')) die('--declare replaces --config/--code; a hand-declared inventory has nothing to reconcile against. Use one or the other.')
    if (opt('robot')) die('--robot carries an FTC hub census, which a hand-declared robot has no equivalent of. Drop --robot.')
    if (!existsSync(declarePath)) die(`Inventory file not found: ${declarePath}`)
    try { inventory = parseInventory(readFileSync(declarePath, 'utf8'), { filename: declarePath }) } catch (e) { die(e.message) }
  }

  const { findings, context } = inventory ? { findings: [], context: null } : runCheck()
  const v = inventory ? null : verdict(findings)
  if (v === 'FAIL') {
    console.log(renderTerminal(findings, context))
    die('Refusing to save a verified state over a FAILING check — verification means a human vouched for a working robot.')
  }
  migrateLegacy('.', { engineVersion: ENGINE_VERSION })
  const configPath = inventory ? declarePath : opt('config')
  const configBytes = readFileSync(configPath)
  const configName = basename(configPath).replace(/\.(xml|json)$/i, '')
  let robot = null, stimulus = null
  // A measurement file carries no timestamp, so a byte-identical report is
  // indistinguishable from a fresh one — and folding the PREVIOUS baseline's
  // report into the NEW state asserts a measurement that was never taken.
  // (The same protection recorded results already get via staleFolds.)
  const priorState = latestState('.')
  // A re-submitted measurement is DROPPED, not folded — and never blocks the
  // save. (Same shape as staleFolds for recorded results: the team may have
  // done real work worth keeping; what they must not get is a verified state
  // asserting a measurement nobody retook. Absence is then recorded honestly
  // as a coverage gap, which is exactly what it is.)
  const staleReports = []
  for (const [flag, label] of [['robot', 'robot report'], ['stimulus', 'stimulus report']]) {
    if (!opt(flag) || !priorState) continue
    const seen = priorState.declared?.reportDigests?.[flag]
    if (seen && seen === sha256Hex(readFileSync(opt(flag)))) staleReports.push({ flag, label })
  }
  if (opt('robot')) {
    try { robot = parseRobotReport(readFileSync(opt('robot'), 'utf8')) } catch (e) { die(`Cannot read robot report: ${e.message}`) }
  }
  if (opt('stimulus')) {
    try { stimulus = parseStimulusReport(readFileSync(opt('stimulus'), 'utf8')) } catch (e) { die(`Cannot read stimulus report: ${e.message}`) }
    if (stimulus.aborted) die('Refusing to fold an aborted stimulus pass into a verified state.')
  }
  const reportDigests = {}
  for (const f of ['robot', 'stimulus']) if (opt(f)) reportDigests[f] = sha256Hex(readFileSync(opt(f)))
  const counts = { WARN: findings.filter((f) => f.severity === 'WARN').length, INFO: findings.filter((f) => f.severity === 'INFO').length }
  // Recorded behavioral results newer than the previous baseline belong to
  // THIS verification cycle — they fold in as human-recorded evidence.
  const prior = latestState('.')
  // Simulated results never fold into a verified state: demo data cannot
  // become evidence about a real robot by being saved.
  let cycleResults = [...latestResults(loadResults('.').filter((r) => r.simulated !== true), { after: prior?.createdAt }).values()]
  // The same cutoff rule `status` enforces applies at the fold: a result
  // recorded BEFORE a human-reported change that put its test in question
  // describes a robot that no longer exists — folding it would launder the
  // exact result status refuses to accept.
  const absorbedReports = prior ? reportedSince(loadReported('.'), prior.createdAt).map(asChange) : []
  let staleFolds = []
  if (absorbedReports.length && cycleResults.length) {
    const foldPlan = plan({ state: prior, changes: absorbedReports, graph: loadGraph('.') })
    const reportAt = new Map(absorbedReports.map((c) => [c.id, c.at]))
    const cutoffByTest = new Map()
    for (const req of [...foldPlan.required, ...foldPlan.satisfiedThisRun]) {
      const bare = req.action.startsWith('test:') ? req.action.slice(5) : req.action.startsWith('calibration:') ? req.action.slice(12) : null
      if (bare == null) continue
      const cut = (req.becauseIds ?? []).reduce((m, id) => { const t = reportAt.get(id); return t != null && t > m ? t : m }, '')
      if (cut) cutoffByTest.set(bare, cut)
    }
    staleFolds = cycleResults.filter((r) => cutoffByTest.has(r.testId) && r.recordedAt <= cutoffByTest.get(r.testId))
    cycleResults = cycleResults.filter((r) => !staleFolds.includes(r))
  }
  // And a FAIL never freezes into "verified" silently — the same rule the
  // check verdict already gets, applied to behavioral results.
  const failFolds = cycleResults.filter((r) => r.verdict === 'FAIL')
  if (failFolds.length) {
    die(`Refusing to save a verified state holding FAILING recorded results — ${failFolds.map((r) => `test:${r.testId}${r.value != null ? ` (${r.value})` : ''}`).join(', ')}.\nVerification means a human vouched for a working robot, not a frozen record of known defects. Record a passing re-run first, or an explicit --unknown with notes on what changed.`)
  }
  const state = buildVerifiedState({
    version: nextVersion('.'), configName, configXml: configBytes,
    robotId: inventory?.robotId ?? 'robot',
    devices: inventory
      ? toStateDevices(inventory)
      : parseConfigXml(configBytes.toString('utf8')).devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus ?? null })),
    checkVerdict: v, checkFindingCounts: counts, robot, stimulus, results: cycleResults, engineVersion: ENGINE_VERSION,
    codeGit: inventory ? null : gitStateOf(opt('code')),
    codeDigest: inventory ? null : (context?.codeDigest ?? null),
    filesScanned: inventory ? null : (context?.filesScanned ?? null),
    reportDigests,
    // Carried-over, not re-measured: the file is byte-identical to the one
    // already folded into the previous state. The observed layer is still
    // RECORDED (dropping it would make the next run see the hardware
    // "reappear"), but every row it produces is UNKNOWN rather than PASS —
    // a re-submitted file must never satisfy an owed recheck.
    carriedOver: staleReports.map((s) => s.flag),
    ...(inventory ? { declaredBy: 'hand', declaredByHuman: inventory.declaredBy } : {}),
  })
  const path = saveState(state)
  // Remember the inputs so the NEXT run — the one that happens mid-panic
  // after a robot change — needs zero flags.
  if (!inventory && opt('config')) rememberInputs({ config: opt('config'), code: opt('code'), ...(opt('robot') ? { robot: opt('robot') } : {}), ...(opt('stimulus') ? { stimulus: opt('stimulus') } : {}) })
  // A new verified state ends the workflow — seal any open shadow experiment.
  const sealed = closeExperiment({ newStateVersion: state.version }, '.')
  const unknowns = state.evidence.filter((e) => e.result === 'UNKNOWN').length
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, action: 'state-saved', version: state.version, path, evidence: state.evidence.length, unknown: unknowns, coverage: state.coverage, staleResultsNotFolded: staleFolds.map((r) => r.testId), absorbedReports: absorbedReports.length, ...(inventory ? { declaredBy: inventory.declaredBy, platform: inventory.platform, warnings: inventory.warnings } : {}) }, null, 2))
    process.exit(0)
  }
  console.log(`Verified state V${state.version} saved → ${path}`)
  console.log(`  evidence: ${state.evidence.length} items (${unknowns} UNKNOWN — stated, not hidden)`)
  // A recorded FAIL is KEPT (hiding it would be worse) but it is never quiet,
  // and status refuses to call this robot verified until it is re-derived.
  const savedFailures = state.evidence.filter((e) => e.result === 'FAIL')
  if (savedFailures.length) {
    console.log(`  ✗ ${savedFailures.length} FAILING evidence row(s) recorded: ${savedFailures.map((e) => e.id).join(', ')}`)
    console.log('    Kept as history — but this is a robot with a known defect, so `physync status`')
    console.log(`    reports VALIDATION FAILED against V${state.version} until that evidence is re-derived passing.`)
  }
  console.log(`  coverage: hubs ${state.coverage.hubs ? '✓' : '—'} · sensors ${state.coverage.sensors ? '✓' : '—'} · stimulus ${state.coverage.stimulus ? '✓' : '—'} · reconciled ${state.coverage.reconciled ? '✓' : '—'}`)
  for (const s of staleReports) {
    console.log(`  ⚠ NOT folded: the ${s.label} was byte-identical to the one already in V${priorState.version} — the same measurement, not a new one.`)
    console.log(`     Nothing it would have established is claimed here; re-run it and save again, or accept the coverage gap.`)
  }
  for (const r of staleFolds) {
    console.log(`  ⚠ NOT folded: test:${r.testId} (${r.verdict}, ${r.recordedAt}) — recorded BEFORE a reported change put it in question; re-run it against the current robot.`)
  }
  if (absorbedReports.length) {
    console.log(`  Note: ${absorbedReports.length} human-reported change(s) predate this save and are superseded by it — saving records a human's decision that V${state.version} is the verified robot now.`)
  }
  if (inventory) {
    console.log(`\n  DECLARED BY HAND — ${inventory.platformLabel}, ${inventory.devices.length} devices, declared by ${inventory.declaredBy}.`)
    console.log('  Nothing here was read off the robot and nothing was reconciled against your code.')
    console.log('  This baseline records what a person SAYS is on the robot. Its value is as the')
    console.log('  thing later changes are measured against — not as proof the robot matches it.')
    for (const w of inventory.warnings) console.log(`    ⚠ ${w}`)
  }
  if (sealed) console.log(`  Shadow experiment ${sealed.id} closed → V${state.version}${sealed.debrief ? '' : ' (NO DEBRIEF was recorded — the comparison data is incomplete)'}`)
  console.log('History is append-only: re-verifying later creates V' + (state.version + 1) + ', never edits V' + state.version + '.')
  process.exit(0)
}

if (cmd === 'predict') {
  if (args.includes('--abandon')) {
    const e = closeExperiment({ abandoned: true }, '.')
    if (!e) die('No open experiment to abandon.')
    console.log(`Experiment ${e.id} abandoned (recorded, not deleted — abandonment is data too).`)
    process.exit(0)
  }
  let rec
  try { rec = predict({ checks: opt('checks'), note: opt('note') ?? '', by: opt('by'), baseline: latestState('.') ? `V${latestState('.').version}` : null }, '.') } catch (e) { die(e.message) }
  console.log(`\n  SHADOW MODE armed: ${rec.id} — prediction by ${rec.predictedBy} recorded at ${rec.predictedAt}`)
  if (rec.prediction.checks.length) console.log(`  predicted checks: ${rec.prediction.checks.join(' · ')}`)
  if (rec.prediction.note) console.log(`  note: "${rec.prediction.note}"`)
  console.log('  This prediction is IMMUTABLE once a status run reveals Nexum\'s answer.')
  // The comparison is an exact set match, so the team has to be told the
  // vocabulary it is matched against — otherwise "camera calibration" vs
  // "camera-pose" reads as a disagreement that never happened.
  const known = (() => { try { return loadTests('.').map((t) => t.id) } catch { return [] } })()
  if (known.length) {
    console.log(`\n  Name checks the way Nexum does, so the comparison lines up. Yours are:`)
    console.log(`    ${known.join(' · ')}`)
    console.log('    (plus: check · preflight · stimulus — see them in `physync tests`)')
  }
  console.log('\n  Next: run physync status — then do the work — then physync debrief.\n')
  process.exit(0)
}

if (cmd === 'debrief') {
  let rec
  try { rec = debrief({ checked: opt('checked'), notes: opt('notes') ?? '', by: opt('by') }, '.') } catch (e) { die(e.message) }
  const d = rec.debrief.deltas
  if (args.includes('--json')) { console.log(JSON.stringify({ physync: 1, experiment: rec }, null, 2)); process.exit(0) }
  console.log(`\n  DEBRIEF ${rec.id} — team plan vs Nexum plan vs what actually happened (set facts only; the verdict is a human's job):`)
  console.log(`    agreed (both named it):            ${d.agreed.join(', ') || '—'}`)
  console.log(`    Nexum added beyond prediction:     ${d.nexumAddedBeyondPrediction.join(', ') || '—'}`)
  console.log(`      …of which actually performed:    ${d.usefulAdditions.join(', ') || '—'}`)
  console.log(`    prediction beyond Nexum:           ${d.predictionBeyondNexum.join(', ') || '—'}`)
  console.log(`    recommended but not performed:     ${d.recommendedNotPerformed.join(', ') || '—'}   (EXTRA WORK candidates — human verdict decides)`)
  console.log(`    performed though unrecommended:    ${d.performedUnrecommended.join(', ') || '—'}   (NEXUM MISSED candidates — human verdict decides)`)
  // The verdict definitions are printed HERE, in full. They used to point at
  // ledger/SHADOW-PROTOCOL.md — a file that does not ship — which left the
  // tester citing a rulebook they could not read.
  console.log('\n  Now YOU assign the verdict (Nexum never grades itself). The definitions:')
  console.log('    HELPED      Nexum named a check you had not planned, you did it, and it')
  console.log('                mattered — it found something, or you would have skipped it.')
  console.log('    NO VALUE    Nexum\'s list was contained in yours. Nothing new.')
  console.log('    EXTRA WORK  You did a Nexum-only check, it passed, and it felt unnecessary.')
  console.log('    MISSED      Something went wrong later that traced back to this change,')
  console.log('                and Nexum never named it.')
  console.log('    AMBIGUOUS   Anything else. This is a real answer — use it freely.')
  console.log('    physync verdict --verdict HELPED|"NO VALUE"|"EXTRA WORK"|MISSED|AMBIGUOUS --basis "<why, one sentence>" --by <you>')
  console.log('  Then close the loop: perform owed checks, record results, physync state …\n')
  process.exit(0)
}

if (cmd === 'verdict') {
  let rec
  try { rec = assignVerdict({ verdict: opt('verdict'), basis: opt('basis'), by: opt('by') }, '.') } catch (e) { die(e.message) }
  console.log(`Verdict for ${rec.id}: ${rec.debrief.verdict} — ${rec.debrief.verdictBasis}`)
  process.exit(0)
}

if (cmd === 'experiment') {
  const all = listExperiments('.')
  if (args.includes('--json')) { console.log(JSON.stringify({ physync: 1, experiments: all }, null, 2)); process.exit(0) }
  if (!all.length) { console.log('No shadow-mode experiments recorded. Arm one BEFORE looking at status: physync predict --checks "a, b" --by <you>'); process.exit(0) }
  for (const e of all) {
    console.log(`${e.id} · predicted ${e.predictedAt} by ${e.predictedBy} · revealed ${e.revealedAt ?? '—'} · debriefed ${e.debriefedAt ?? '—'} · closed ${e.closedAt ?? 'OPEN'}${e.newState ? ` → ${e.newState}` : ''}${e.abandoned ? ' (abandoned)' : ''}${e.debrief?.verdict ? ` · verdict: ${e.debrief.verdict}` : ''}`)
  }
  process.exit(0)
}

if (cmd === 'states') {
  migrateLegacy('.', { engineVersion: ENGINE_VERSION })
  const all = listStates('.')
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, states: all.map((s) => ({ version: s.version, createdAt: s.createdAt, origin: s.origin ?? 'native', configName: s.declared.configName, evidence: s.evidence.length, unknown: s.evidence.filter((e) => e.result === 'UNKNOWN').length, coverage: s.coverage })) }, null, 2))
    process.exit(0)
  }
  if (!all.length) { console.log('No verified states yet — create one with `physync state` after a hand-verified PASS.'); process.exit(0) }
  for (const s of all) {
    console.log(`V${s.version} · ${s.createdAt} · config "${s.declared.configName}" · ${s.evidence.length} evidence (${s.evidence.filter((e) => e.result === 'UNKNOWN').length} UNKNOWN) · hubs ${s.coverage.hubs ? '✓' : '—'} sensors ${s.coverage.sensors ? '✓' : '—'} stimulus ${s.coverage.stimulus ? '✓' : '—'}${s.origin ? ` · ${s.origin}` : ''}`)
  }
  process.exit(0)
}

if (cmd === 'change') {
  // A physical change nobody's files can see. This records a PERSON'S STATEMENT
  // and labels it as one, for the whole life of the record.
  if (args.includes('--list')) {
    const reports = loadReported('.')
    if (!reports.length) {
      console.log('\n  No self-reported physical changes.\n  Record one: physync change --component camera-position --note "re-aimed the mount" --by <yourName>\n')
      process.exit(0)
    }
    console.log('\n  SELF-REPORTED PHYSICAL CHANGES (a person\'s word, not a detection):\n')
    for (const r of reports) {
      console.log(`    ${r.id}  ${r.component}`)
      console.log(`         reported by ${r.by} at ${r.at}${r.note ? ` — "${r.note}"` : ''}`)
    }
    console.log('')
    process.exit(0)
  }
  const component = opt('component') ?? die('physync change needs --component <node-id> (for example: camera-position). See `physync graph` for the node vocabulary.')
  const by = opt('by') ?? die('physync change needs --by <yourName> — a self-reported change is somebody\'s word, so the record says whose.')
  let rec
  try { rec = recordReported({ component, note: opt('note', ''), by }, '.') } catch (e) { die(e.message) }

  console.log(`\n  Recorded ${rec.id}: ${rec.component}  [HUMAN-REPORTED CHANGE — human/self-reported by ${rec.by}]`)
  if (rec.note) console.log(`    "${rec.note}"`)
  console.log('\n  This is a REPORTED change, not a detected one. It is stored as your statement')
  console.log('  about the robot and will select rechecks only through APPROVED graph edges.')

  // Tell them immediately whether anything approved actually leads out of this
  // node — so a report that changes nothing says so now, not silently later.
  const g = loadGraph('.')
  const out = [...g.builtin, ...g.custom.filter((e) => e.status !== 'proposed')]
    .filter((e) => e.from === rec.component || (e.from.includes('$n') && rec.component.startsWith(e.from.split('$n')[0])))
  const proposed = g.custom.filter((e) => e.status === 'proposed' && e.from === rec.component)
  if (out.length) {
    console.log(`\n  ${out.length} approved edge(s) lead out of "${rec.component}" — run \`physync status …\` to see the required rechecks.`)
  } else {
    console.log(`\n  ⚠ No APPROVED edge leads out of "${rec.component}", so this reports a change that`)
    console.log('    invalidates nothing automatically. It will appear under NO DEPENDENCY MAPPING')
    console.log('    for a human to judge.')
    if (proposed.length) {
      console.log(`\n    ${proposed.length} PROPOSED edge(s) exist from this node but are inactive until approved:`)
      for (const e of proposed) console.log(`      ${e.id}: ${e.from} → ${e.to}   (physync graph --approve ${e.id} --by <name>)`)
    }
  }
  console.log('')
  process.exit(0)
}

if (cmd === 'status') {
  // The new core question: this robot changed — what can we still trust?
  reuseRememberedInputs()
  migrateLegacy('.', { engineVersion: ENGINE_VERSION })
  const base = latestState('.')
  if (!base) die('No verified state on record — save one first: physync state --config <xml> --code <dir> [--robot r.json]\n  (hand-declared robots: physync state --declare <inventory.json>)')

  const declarePath = opt('declare')
  let inventory = null
  if (declarePath) {
    if (opt('config') || opt('code') || opt('robot')) die('--declare replaces --config/--code/--robot. Use one or the other.')
    if (!existsSync(declarePath)) die(`Inventory file not found: ${declarePath}`)
    try { inventory = parseInventory(readFileSync(declarePath, 'utf8'), { filename: declarePath }) } catch (e) { die(e.message) }
  }
  // A baseline and a candidate must be the same KIND of claim, or the diff
  // between them is meaningless: comparing a parsed hub config against a
  // hand-written list would report every device as changed.
  const baseIsHand = base.declared.source === 'hand'
  if (baseIsHand && !inventory) die(`V${base.version} was declared by hand — compare it with \`physync status --declare <inventory.json>\`, not --config.`)
  if (!baseIsHand && inventory) die(`V${base.version} came from a parsed configuration file — compare it with \`physync status --config <xml> --code <dir>\`, not --declare.`)

  const { findings, context } = inventory ? { findings: [], context: null } : runCheck()
  const failFindings = findings.filter((f) => f.severity === 'FAIL').length
  const configPath = inventory ? declarePath : opt('config')
  const candidate = {
    configName: basename(configPath).replace(/\.(xml|json)$/i, ''),
    configXml: readFileSync(configPath),
    codeGit: inventory ? null : gitStateOf(opt('code')),
    codeDigest: inventory ? null : (context?.codeDigest ?? null),
  }
  if (opt('robot')) {
    let robot
    try { robot = parseRobotReport(readFileSync(opt('robot'), 'utf8')) } catch (e) { die(`Cannot read robot report: ${e.message}`) }
    candidate.hubs = robot.hubs
    candidate.sensors = robot.sensors
    candidate.fingerprints = robot.fingerprints
  }
  candidate.devices = inventory
    ? toStateDevices(inventory)
    : parseConfigXml(candidate.configXml.toString('utf8')).devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus ?? null }))
  let fingerprintDefs = []
  try { fingerprintDefs = loadFingerprintDefs('.') } catch (e) { die(e.message) }
  const { changes, gaps, standing } = detectChanges(base, candidate, { fingerprintDefs })

  // Self-reported physical changes made SINCE the baseline was saved. Older
  // reports describe a robot that has since been re-verified, so they are
  // history. These carry source 'human' all the way through and are rendered
  // separately from anything detected.
  const statusGraph = loadGraph('.')
  const reported = reportedSince(loadReported('.'), base.createdAt).map(asChange)
  changes.push(...reported)

  // Phase 3: what did those changes invalidate, and what is the MINIMUM
  // revalidation? Evidence re-derived by this very run counts as satisfied.
  // Phase 4: recorded results newer than the baseline satisfy (PASS), doom
  // (FAIL), or leave open (UNKNOWN) the demanded behavioral tests.
  let revalidation = null
  let resultFailures = 0
  // Simulated results are excluded from satisfaction entirely (demo evidence
  // cannot verify a real robot) but their presence is surfaced, not hidden.
  const allResults = loadResults('.')
  const realResults = allResults.filter((r) => r.simulated !== true)
  const recent = latestResults(realResults, { after: base.createdAt })
  const recentSimulated = latestResults(allResults.filter((r) => r.simulated === true), { after: base.createdAt })
  const consumedTests = new Set()
  if (changes.length) {
    const satisfied = new Set()
    // This run IS a fresh reconciliation — but only when one actually ran. A
    // --declare run reconciles nothing, so an empty findings list must not be
    // mistaken for a clean one. ('declare' is never auto-satisfied either: only
    // a person walking the robot re-derives a hand-declared inventory.)
    if (!inventory && failFindings === 0) satisfied.add('check')
    // NOT satisfied.add('preflight'): that asserted a fresh report re-derived
    // every census/liveness row, including ones it omitted or showed failing.
    // Re-derivation is decided per row, by what the report actually says.
    const rederivedTargets = rederivedFrom(base, candidate, changes)
    revalidation = plan({ state: base, changes, graph: statusGraph, satisfiedActions: satisfied, rederivedTargets })

    // A result can only answer a change made before it was recorded. Human-
    // reported changes carry the moment the change was made known; a PASS
    // recorded before that moment describes the robot as it used to be.
    // Detected changes have no knowable change time, so their cutoff stays
    // the baseline (all that can honestly be enforced).
    const reportedAt = new Map(changes.filter((c) => c.source === 'human' && c.at).map((c) => [c.id, c.at]))
    const cutoffFor = (req) => (req.becauseIds ?? []).reduce((m, id) => { const t = reportedAt.get(id); return t != null && t > m ? t : m }, base.createdAt)
    const stillRequired = []
    for (const req of revalidation.required) {
      const bareId = req.action.startsWith('test:') ? req.action.slice(5) : req.action.startsWith('calibration:') ? req.action.slice(12) : null
      const recorded = bareId != null ? recent.get(bareId) : null
      const simulatedOnly = bareId != null && !recorded ? recentSimulated.get(bareId) : null
      if (bareId != null) consumedTests.add(bareId)
      const cutoff = cutoffFor(req)
      if (recorded && recorded.recordedAt <= cutoff) {
        stillRequired.push({ ...req, label: `${req.label} — latest result (${recorded.verdict}, ${recorded.recordedAt}) PREDATES the reported change it must answer; re-run` })
      } else if (recorded?.verdict === 'PASS') {
        revalidation.satisfiedThisRun.push({ ...req, label: `${req.label} — PASS recorded ${recorded.recordedAt} by ${recorded.recordedBy}` })
        // a fresh recorded PASS re-derives the evidence it covers — the
        // applicability table must agree with the satisfaction decision
        for (const t of req.targets) {
          const id = t.replace(' (no recorded result — UNKNOWN)', '')
          // A folded calibration result lives under `test:X` while the graph
          // demands `calibration:X` — the same referent. Without the alias the
          // lookup missed and the row stayed REVALIDATE beside a plan that
          // said it was satisfied: the table contradicting the same screen.
          const alias = id.startsWith('calibration:') ? `test:${id.slice(12)}` : id.startsWith('test:') ? `calibration:${id.slice(5)}` : null
          const row = revalidation.applicability?.find((a) => a.evidenceId === id)
            ?? (alias ? revalidation.applicability?.find((a) => a.evidenceId === alias) : undefined)
          if (row && row.applicability === APPLICABILITY.REVALIDATE) {
            row.applicability = APPLICABILITY.REDERIVED
            row.reasonCodes = []
            row.reason = `PASS recorded ${recorded.recordedAt} by ${recorded.recordedBy}`
          }
        }
      } else if (recorded?.verdict === 'FAIL') {
        resultFailures++
        stillRequired.push({ ...req, label: `${req.label} — LATEST RESULT IS FAIL (${recorded.value ?? 'explicit'}, ${recorded.recordedAt})` })
      } else if (simulatedOnly) {
        stillRequired.push({ ...req, label: `${req.label} — only a SIMULATED result on file (${simulatedOnly.verdict}); simulated evidence satisfies nothing` })
      } else {
        stillRequired.push(req) // missing or UNKNOWN: still owed. UNKNOWN never passes.
      }
    }
    revalidation.required = stillRequired
  }
  // A recorded FAIL is a standing fact about the robot whether or not any
  // change demanded that test. Surfacing it only during revalidation let a
  // known-failing robot read as VERIFIED with an unchanged config.
  const standingFailures = [...recent.values()].filter((r) => r.verdict === 'FAIL' && !consumedTests.has(r.testId))
  resultFailures += standingFailures.length
  // A baseline written before FAIL evidence was refused at build time (or by
  // an older engine) must not keep reading as VERIFIED. The row is history
  // and stays history; the STATUS stops claiming the robot is fine.
  const baselineFailures = base.evidence.filter((e) => e.result === 'FAIL').map((e) => e.id)
  resultFailures += baselineFailures.length
  // Regressions are computed whether or not anything changed — hiding a real
  // regression behind "no changes" was a lie of omission. Simulated results
  // never enter the math.
  const regressions = detectRegressions(realResults)

  // The reconciliation row cannot read "still applies" while THIS run's
  // reconciliation is failing — the row's own subject is refuted on the same
  // screen. (No graph edge covers it: a fresh check re-derives reconciliation
  // directly, so the honest source is the live finding count, not a path.)
  if (failFindings > 0 && revalidation?.applicability) {
    for (const row of revalidation.applicability) {
      if (row.evidenceId !== 'config-code-reconciled' && row.evidenceId !== 'config-parsed') continue
      if (row.applicability === APPLICABILITY.APPLICABLE || row.applicability === APPLICABILITY.REDERIVED) {
        row.applicability = APPLICABILITY.REVALIDATE
        row.reasonCodes = ['CONFIGURATION_CHANGED']
        row.reason = `this run's config↔code reconciliation is FAILING (${failFindings} finding(s)) — the baseline's passing reconciliation does not describe today's robot`
      }
    }
  }
  const status = deploymentStatus({ failFindings: failFindings + resultFailures, changes, gaps })
  // SHADOW MODE reveal — the first status after a prediction stamps the
  // moment Nexum's answer became visible, and snapshots that answer. The
  // prediction is immutable from here on.
  // Nexum's answer is required PLUS satisfiedThisRun: a check it demanded
  // that the team had already done is still a check it named. Recording only
  // `required` scored those as "the team went beyond Nexum" and manufactured
  // MISSED verdicts against ourselves — corrupting the experiment in our own
  // disfavour, which is still corrupt.
  // And a run with NO changes has no answer to reveal; stamping it would
  // freeze the snapshot as "Nexum recommended nothing" before the real
  // comparison ever happened (first reveal wins, permanently).
  // THE ORDERING GUARD. Reading Nexum's answer contaminates a prediction that
  // was never written down — and unlike every other mistake in this tool, that
  // one cannot be undone: the team's uninfluenced judgment is gone for this
  // change, permanently. In a supervised session a human prevents it; remotely
  // the product has to. So when there are changes and no prediction is armed,
  // WHAT CHANGED is still shown (they can see that on their own robot anyway —
  // it contaminates nothing), but the applicability table and the plan are
  // withheld behind one command. --reveal is the deliberate escape hatch for
  // anyone who is not running the experiment.
  // …and ONLY for a project that opted into the experiment by running `init`.
  // Gating everyone would hold the core feature hostage to a study they never
  // signed up for — the tool's job is to answer the question, and the beta is
  // our interest, not theirs.
  const betaMode = existsSync('.physync/beta.json')
  const armed = (() => { try { return openExperiment('.') } catch { return null } })()
  const gateOrdering = betaMode && !armed && !args.includes('--reveal')
  if (changes.length && gateOrdering && args.includes('--json')) {
    // Machine consumers get the same gate as a fact, not as prose.
    console.log(JSON.stringify({
      physync: 1, predictionRequired: true, against: `V${base.version}`, changes,
      hint: 'record the human prediction first: physync predict --checks "a, b" --by <name>; or pass --reveal',
      exit: statusExitCode(status),
    }, null, 2))
    process.exit(statusExitCode(status))
  }
  if (changes.length && gateOrdering) {
    console.log(`\n  ${process.stdout.isTTY ? '\x1b[33m' : ''}██ ${changes.length} CHANGE(S) DETECTED — PREDICTION NOT YET RECORDED ██${process.stdout.isTTY ? '\x1b[0m' : ''}   (vs V${base.version})\n`)
    for (const c of changes) {
      console.log(c.source === 'human'
        ? `    • ${c.component} — reported by ${c.by}${c.note ? `: "${c.note}"` : ''}`
        : `    • ${c.component}: ${c.previous ?? '(absent)'} → ${c.current ?? '(absent)'}`)
    }
    console.log('\n  Before Nexum tells you what IT would re-check, write down what YOU would:')
    console.log('    node app/bin/physync.js predict --checks "a, b" --by <yourName>')
    console.log('\n  Then run status again and you\'ll get the full answer. This takes 20 seconds')
    console.log('  and it is the entire point of the beta — once you\'ve read Nexum\'s list,')
    console.log('  nobody can ever know what you would have checked on your own.')
    console.log(`\n  Not running the experiment? ${'node app/bin/physync.js status --reveal'} shows everything now.\n`)
    process.exit(statusExitCode(status))
  }
  const shadow = changes.length === 0 ? null : markRevealed({
    changes,
    planActions: revalidation ? [...revalidation.required, ...revalidation.satisfiedThisRun].map((r) => r.action) : [],
    applicabilityCounts: revalidation ? revalidation.applicability.reduce((m, a) => ({ ...m, [a.applicability]: (m[a.applicability] ?? 0) + 1 }), {}) : {},
  }, '.')
  const out = { physync: 1, status, against: `V${base.version}`, failFindings, resultFailures, standingFailures, changes, gaps, standing, revalidation, regressions, experiment: shadow ? { id: shadow.id, predictedAt: shadow.predictedAt, revealedAt: shadow.revealedAt } : null, exit: statusExitCode(status) }
  if (args.includes('--json')) {
    console.log(JSON.stringify(out, null, 2))
    process.exit(statusExitCode(status))
  }
  const paint = status === STATUSES.VERIFIED ? '\x1b[32m' : status === STATUSES.FAILED ? '\x1b[31m' : '\x1b[33m'
  const reset = process.stdout.isTTY ? '\x1b[0m' : ''
  console.log(`\n  ${process.stdout.isTTY ? paint : ''}██ ${status} ██${reset}   (vs verified state V${base.version}, ${base.createdAt})`)
  // One-line situation summary — the Sentry rule: lead with what happened
  // and what it costs, before any detail.
  const sumBits = [
    `${changes.length} change(s)`,
    revalidation ? `${revalidation.invalidated.length} evidence item(s) put in question` : null,
    revalidation ? `${revalidation.required.length} recheck(s) owed` : null,
    resultFailures ? `${resultFailures} failing result(s)` : null,
    gaps.length ? `${gaps.length} not compared` : null,
  ].filter(Boolean)
  console.log(`  ${sumBits.join(' · ')}\n`)
  if (inventory) {
    console.log(`  HAND-DECLARED ROBOT (${inventory.platformLabel}) — no configuration file was parsed and no`)
    console.log('  code was reconciled. What follows compares your declaration against the one you')
    console.log('  last saved, plus what people have reported. It establishes nothing about wiring.')
    for (const w of inventory.warnings) console.log(`    ⚠ ${w}`)
    console.log('')
  }
  if (failFindings) console.log(`  ✗ ${failFindings} FAILING check finding(s) — run \`physync check\` for the detail\n`)
  if (resultFailures) console.log(`  ✗ ${resultFailures} test(s) whose LATEST RECORDED RESULT IS FAIL\n`)
  if (standingFailures.length) {
    console.log('  RECORDED FAILING RESULTS (standing — no change demanded these, they are simply failing):')
    for (const r of standingFailures) console.log(`    ✗ test:${r.testId}${r.value != null ? ` = ${r.value}` : ''} — recorded ${r.recordedAt} by ${r.recordedBy}`)
    console.log('')
  }
  for (const r of regressions) console.log(`  ⚠ REGRESSION: ${r.testId} ${r.previous.value} → ${r.current.value} (Δ ${+r.delta.toFixed(6)})`)
  if (regressions.length) console.log("")
  const detected = changes.filter((c) => c.source !== 'human')
  const selfReported = changes.filter((c) => c.source === 'human')
  if (detected.length) {
    console.log('  WHAT CHANGED (detected by comparing files and reports):')
    for (const c of detected) console.log(`    • [${c.source}/${c.method}] ${c.component}: ${c.previous ?? '(absent)'} → ${c.current ?? '(absent)'}`)
    console.log('')
  }
  if (selfReported.length) {
    console.log('  HUMAN-REPORTED CHANGE (not detected — nothing was measured):')
    for (const c of selfReported) {
      console.log(`    • [${c.source}/${c.method}] ${c.component} — reported by ${c.by}${c.note ? `: "${c.note}"` : ''}`)
    }
    console.log('')
  }
  if (gaps.length) {
    console.log('  NOT COMPARED (evidence exists in the state, nothing supplied now):')
    for (const g of gaps) console.log(`    ? ${g}`)
    console.log('')
  }
  if (shadow?.revealedAt) {
    console.log(`  SHADOW MODE — ${shadow.predictedBy}'s prediction locked at ${shadow.predictedAt}; Nexum's answer is revealed below.`)
    console.log('  After performing the checks: physync debrief --checked "a, b" --by <you>\n')
  }
  if (revalidation) {
    if (revalidation.invalidated.length) {
      console.log(`  INVALIDATED EVIDENCE (from V${base.version}):`)
      for (const inv of revalidation.invalidated) console.log(`    ✝ ${inv.evidenceId} — because ${(inv.becauseHuman ?? inv.because).join('; ')}`)
      console.log('')
    }
    // Results are history and never change; APPLICABILITY answers "does that
    // history still describe THIS robot?" — fresh every run, per evidence row.
    if (revalidation.applicability?.length) {
      const MARK = { [APPLICABILITY.APPLICABLE]: '✓', [APPLICABILITY.REVALIDATE]: '!', [APPLICABILITY.UNKNOWN]: '?', [APPLICABILITY.REDERIVED]: '↻' }
      console.log('  EVIDENCE APPLICABILITY (historical results never change — this is what still describes TODAY\'S robot):')
      for (const a of revalidation.applicability) {
        const codes = a.reasonCodes?.length ? ` [${a.reasonCodes.join(', ')}]` : ''
        console.log(`    ${MARK[a.applicability] ?? '·'} ${a.applicability.padEnd(11)} ${a.evidenceId} (${a.result} @V${base.version}) — ${a.reason}${codes}`)
      }
      console.log('')
    }
    if (revalidation.required.length) {
      console.log('  REQUIRED REVALIDATION (minimum set, ordered upstream-first — an upstream FAIL can make later checks moot):')
      const edgeById = new Map([...statusGraph.builtin, ...statusGraph.custom].map((e) => [e.id, e]))
      for (const r of revalidation.required) {
        console.log(`    ${r.order}. ${r.label}${r.reasonCodes?.length ? `  [${r.reasonCodes.join(', ')}]` : ''}`)
        for (const t of r.targets) console.log(`        covers: ${t}`)
        console.log(`        required because: ${(r.becauseHuman?.length ? r.becauseHuman : r.because).join('; ')}`)
        // The PATH the demand traveled — who vouched for each hop. A user
        // should never have to trust an unexplained conclusion.
        const hops = (r.via ?? []).map((id) => edgeById.get(id)).filter(Boolean)
        if (hops.length) console.log(`        path: ${hops.map((e) => `${e.from} → ${e.to} ${e.approvedBy ? `(approved by ${e.approvedBy})` : '(deterministic rule)'}`).join(' · ')}`)
        // And the exact next command — an owed check should never leave the
        // user wondering how to tell Nexum they did it.
        const bare = r.action.startsWith('test:') ? r.action.slice(5) : r.action.startsWith('calibration:') ? r.action.slice(12) : null
        if (bare) console.log(`        when done, record it: physync result --test ${bare} --value <n> --by <yourName>   (or --pass / --fail / --unknown)`)
      }
      console.log('')
    }
    if (revalidation.satisfiedThisRun.length) {
      console.log('  SATISFIED BY THIS RUN:')
      for (const r of revalidation.satisfiedThisRun) console.log(`    ✓ ${r.label}${/recorded/.test(r.label) ? '' : ' — re-derived from the inputs you just supplied'}`)
      console.log('')
    }
    if (revalidation.unmappedChanges.length) {
      console.log('  NO DEPENDENCY MAPPING (nothing invalidated automatically — review by hand):')
      for (const u of revalidation.unmappedChanges) console.log(`    ⚠ ${u}`)
      console.log('')
    }
    if (!revalidation.required.length && !revalidation.unmappedChanges.length) {
      const rebase = inventory ? `physync state --declare ${declarePath}` : `physync state --config … --code …${candidate.hubs ? ' --robot …' : ''}`
      console.log(`  All invalidated evidence was re-derived this run — save the new baseline: ${rebase}\n`)
    }
  }
  if (standing.length) {
    console.log('  STANDING EVIDENCE (valid until a change invalidates it):')
    for (const s of standing) console.log(`    ≡ ${s}`)
    console.log('')
  }
  if (status === STATUSES.VERIFIED) console.log('  Everything the verified state established still holds, as of the inputs you supplied.\n')
  process.exit(statusExitCode(status))
}

if (cmd === 'rules') {
  const packName = opt('pack')
  if (!packName) {
    if (args.includes('--json')) {
      console.log(JSON.stringify({ physync: 1, packs: Object.entries(RULE_PACKS).map(([id, p]) => ({ id, label: p.label, note: p.note, edges: p.edges.length })) }, null, 2))
      process.exit(0)
    }
    console.log('\n  RULE PACKS — candidate dependencies for a mentor to judge, never facts PHYSYNC asserts.\n')
    for (const [id, p] of Object.entries(RULE_PACKS)) {
      console.log(`    ${id}  —  ${p.label}  (${p.edges.length} edges)`)
      console.log(`        ${p.note.replace(/(.{78}\S*)\s+/g, '$1\n        ')}\n`)
    }
    console.log('  Load one: physync rules --pack <name>   (loads every edge as PROPOSED — inactive)\n')
    process.exit(0)
  }

  let edges
  try { edges = packEdges(packName) } catch (e) { die(e.message) }
  const g = loadGraph('.')
  const existing = new Set(g.custom.map((e) => `${e.from}→${e.to}`))
  const fresh = edges.filter((e) => !existing.has(`${e.from}→${e.to}`))
  const skipped = edges.length - fresh.length
  // Re-loading a pack must never resurrect an edge a mentor already approved,
  // and must never quietly reset one they considered and left alone.
  for (const e of fresh) validateEdge({ ...e, proposedAt: new Date().toISOString() }, { requireApproved: false })
  saveGraph([...g.custom, ...fresh.map((e) => ({ ...e, proposedAt: new Date().toISOString() }))])

  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, action: 'pack-loaded', pack: packName, proposed: fresh.length, skipped }, null, 2))
    process.exit(0)
  }
  console.log(`\n  Loaded "${packName}" — ${fresh.length} edge(s) stored as PROPOSED${skipped ? `, ${skipped} already present and left untouched` : ''}.\n`)
  for (const e of fresh) console.log(`    ${e.id}: ${e.from} → ${e.to}`)
  console.log('\n  NONE of these affect anything yet. Each is a question for somebody who knows')
  console.log('  your robot: "if this changed, would that need redoing?" Approve the ones that')
  console.log('  are true of YOUR robot and leave the rest proposed — an unapproved edge is')
  console.log('  never traversed, so leaving it costs nothing.\n')
  console.log(`    physync graph --approve ${fresh[0]?.id ?? '<edgeId>'} --by <yourName>\n`)
  process.exit(0)
}

if (cmd === 'graph') {
  const g = loadGraph('.')
  if (args.includes('--propose')) {
    const from = opt('from') ?? die('--propose needs --from <node> and --to <node>')
    const to = opt('to') ?? die('--propose needs --from <node> and --to <node>')
    const edge = validateEdge({ id: `u${g.custom.length + 1}-${from.replace(/[^\w]/g, '_').slice(0, 20)}`, from, to, note: opt('note', ''), status: 'proposed', proposedAt: new Date().toISOString() })
    saveGraph([...g.custom, edge])
    console.log(`Proposed edge ${edge.id}: ${from} → ${to}`)
    console.log('It is STORED but affects nothing until a named human approves it: physync graph --approve ' + edge.id + ' --by <yourName>')
    process.exit(0)
  }
  if (opt('approve')) {
    const by = opt('by') ?? die('--approve needs --by <humanName> — a human signature is what makes an edge real.')
    const id = opt('approve')
    const edge = g.custom.find((e) => e.id === id) ?? die(`No proposed edge "${id}" — see \`physync graph\`.`)
    if (edge.status !== 'proposed') die(`Edge "${id}" is already approved.`)
    edge.status = 'approved'
    edge.source = 'user-approved'
    edge.approvedBy = by
    edge.approvedAt = new Date().toISOString()
    validateEdge(edge)
    saveGraph(g.custom)
    console.log(`Edge ${id} approved by ${by}: ${edge.from} → ${edge.to} — it now affects invalidation and planning.`)
    // An approved edge whose `from` is not a node Nexum can ever emit is
    // INERT — and status would then say "no known dependency connects it to
    // any change" about a dependency literally on record. Say so here, while
    // the person who wrote it is still looking.
    const EMITTED = /^(configuration|software|device:|hub:|firmware:|sensor:|fingerprint:)/
    if (!EMITTED.test(edge.from)) {
      const reported = new Set(loadReported('.').map((r) => r.component))
      if (!reported.has(edge.from)) {
        console.log(`\n  ⚠ Nothing fires this rule yet. Changes Nexum DETECTS are named`)
        console.log('    configuration · software · device:<name> · hub:<addr> · firmware:<addr> · sensor:<name> · fingerprint:<id>')
        console.log(`    "${edge.from}" is none of those, so this edge only activates when a person reports`)
        console.log(`    a change with exactly that component name:`)
        console.log(`      physync change --component ${edge.from} --note "<what happened>" --by <name>`)
        console.log(`    If you meant the configured device "${edge.from}", the node id is  device:${edge.from}`)
      }
    }
    process.exit(0)
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, builtin: g.builtin, custom: g.custom }, null, 2))
    process.exit(0)
  }
  console.log('DEPENDENCY GRAPH — edges that affect decisions carry provenance; proposed edges never do.\n')
  console.log('  Built-in (deterministic rules — true by construction, no approval needed):')
  for (const e of g.builtin) console.log(`    ${e.id}: ${e.from} → ${e.to}   (${e.note})`)
  if (g.custom.length) {
    console.log('\n  Custom:')
    for (const e of g.custom) {
      console.log(`    ${e.id}: ${e.from} → ${e.to}   [${e.status === 'proposed' ? 'PROPOSED — inactive' : `${e.source}, approved by ${e.approvedBy ?? 'n/a'}`}]${e.note ? ` (${e.note})` : ''}`)
    }
  } else {
    console.log('\n  Custom: none — propose one with `physync graph --propose --from <node> --to <node>`,')
    console.log('          or start from a pack: `physync rules` to list, `physync rules --pack vex-v5` to load.')
  }
  process.exit(0)
}

if (cmd === 'tests') {
  const tests = loadTests('.')
  if (args.includes('--define')) {
    const id = opt('id') ?? die('--define needs --id <id>')
    if (tests.some((t) => t.id === id)) die(`Test "${id}" is already defined.`)
    const def = {
      id, kind: opt('kind') ?? 'validation', label: opt('label') ?? die('--define needs --label <text>'),
      definedBy: opt('by') ?? die('--define needs --by <human> — test definitions are engineering decisions with authors.'),
      definedAt: new Date().toISOString(),
    }
    if (opt('min') != null || opt('max') != null) {
      def.threshold = {}
      if (opt('min') != null) def.threshold.min = Number(opt('min'))
      if (opt('max') != null) def.threshold.max = Number(opt('max'))
    }
    validateTestDef(def)
    saveTests([...tests, def])
    console.log(`Defined ${def.kind} test "${id}" (${def.label})${def.threshold ? ` — threshold ${def.threshold.min != null ? '≥' + def.threshold.min : ''}${def.threshold.max != null ? '≤' + def.threshold.max : ''}, set by ${def.definedBy}` : ' — no threshold configured; results without an explicit verdict will be UNKNOWN'}`)
    console.log(`Wire it into the graph so changes demand it: physync graph --propose --from <component> --to test:${id}`)
    process.exit(0)
  }
  if (args.includes('--json')) { console.log(JSON.stringify({ physync: 1, tests }, null, 2)); process.exit(0) }
  if (!tests.length) { console.log('No tests defined — define one with `physync tests --define --id <id> --kind validation|robustness --label "…" [--min 0.9] --by <you>`'); process.exit(0) }
  for (const t of tests) {
    console.log(`test:${t.id} [${t.kind}] "${t.label}"${t.threshold ? ` threshold ${t.threshold.min != null ? '≥' + t.threshold.min : ''}${t.threshold.max != null ? '≤' + t.threshold.max : ''} (${t.definedBy})` : ' (no threshold — explicit verdicts or UNKNOWN)'}`)
  }
  process.exit(0)
}

if (cmd === 'result') {
  const testId = opt('test') ?? die('result needs --test <id>')
  const def = loadTests('.').find((t) => t.id === testId) ?? null
  if (!def) console.error(`⚠ test "${testId}" has no definition — recording anyway (kind defaults to validation, no threshold: verdict is explicit-or-UNKNOWN). Define it: physync tests --define --id ${testId} …`)
  const explicit = args.includes('--pass') ? 'PASS' : args.includes('--fail') ? 'FAIL' : args.includes('--unknown') ? 'UNKNOWN' : null
  const value = opt('value') != null ? Number(opt('value')) : null
  if (opt('value') != null && Number.isNaN(value)) die('--value must be a number')
  const entry = appendResult({
    testId, def, value, explicit,
    evidence: opt('evidence') ? [opt('evidence')] : [],
    notes: opt('notes'), recordedBy: opt('by') ?? die('result needs --by <human> — PHYSYNC does not run behavioral tests; every result has a person behind it.'),
    method: opt('method') ?? null,
    simulated: args.includes('--simulated'),
    againstState: latestState('.') ? `V${latestState('.').version}` : null,
  })
  console.log(`Recorded: test:${testId} → ${entry.verdict}${value != null ? ` (${value}${entry.threshold ? ` vs ${entry.threshold.min != null ? '≥' + entry.threshold.min : '≤' + entry.threshold.max}` : ', no threshold configured'})` : ''} — by ${entry.recordedBy}${entry.method ? ` · method: ${entry.method}` : ''}`)
  if (entry.simulated) console.log('SIMULATED RESULT — recorded for demonstration or drill. It is stored and listed, and it satisfies NOTHING: simulated evidence cannot verify a real robot.')
  if (entry.verdict === 'UNKNOWN' && value != null) console.log('No threshold and no explicit verdict → UNKNOWN. A number without a bar to clear proves nothing yet.')
  const regs = detectRegressions(loadResults('.').filter((r) => r.simulated !== true)).filter((r) => r.testId === testId)
  for (const r of regs) console.log(`⚠ REGRESSION: ${testId} ${r.previous.value} → ${r.current.value} (Δ ${r.delta > 0 ? '+' : ''}${+r.delta.toFixed(6)})`)
  process.exit(entry.verdict === 'FAIL' ? 2 : 0)
}

if (cmd === 'results') {
  const all = loadResults('.')
  const filter = opt('test')
  const shown = filter ? all.filter((r) => r.testId === filter) : all
  // Simulated rows are listed — flagged, never hidden — but they enter no
  // regression math: a drill number must not manufacture a phantom regression.
  const regressions = detectRegressions(all.filter((r) => r.simulated !== true))
  if (args.includes('--json')) { console.log(JSON.stringify({ physync: 1, results: shown, regressions }, null, 2)); process.exit(0) }
  if (!shown.length) { console.log('No results recorded' + (filter ? ` for test "${filter}"` : '') + '.'); process.exit(0) }
  for (const r of shown) {
    console.log(`${r.recordedAt} · test:${r.testId} [${r.kind}] → ${r.verdict}${r.value != null ? ` (${r.value})` : ''}${r.simulated ? ' · SIMULATED (satisfies nothing)' : ''} · by ${r.recordedBy}${r.method ? ` · ${r.method}` : ''}${r.againstState ? ` · against ${r.againstState}` : ''}${r.evidence.length ? ` · evidence: ${r.evidence.join('; ')}` : ''}`)
  }
  for (const r of regressions.filter((x) => !filter || x.testId === filter)) {
    console.log(`⚠ REGRESSION: ${r.testId} ${r.previous.value} → ${r.current.value} (Δ ${+r.delta.toFixed(6)}) · threshold verdict now ${r.thresholdVerdict}`)
  }
  process.exit(0)
}

if (cmd === 'snapshot') {
  const config = loadConfig()
  if (config.devices.length === 0) die('Refusing to snapshot a config with zero devices — an empty baseline makes every future diff pure noise.')
  mkdirSync('.physync', { recursive: true })
  writeFileSync(SNAPSHOT, JSON.stringify(toSnapshot(config), null, 2))
  console.log(`Snapshot recorded: ${config.devices.length} devices, ${config.portals.length} portal(s) → ${SNAPSHOT}`)
  process.exit(0)
}

if (cmd === 'diff') {
  if (!existsSync(SNAPSHOT)) die('No snapshot yet — run `physync snapshot --config <xml>` after your next verified PASS.')
  const config = loadConfig()
  const findings = diffSnapshot(loadSnapshot(), toSnapshot(config))
  const diffContext = { deviceCount: config.devices.length, webcamCount: config.webcams.length, refCount: 0, filesScanned: 0, mode: 'diff', engineVersion: ENGINE_VERSION }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ physync: 1, verdict: verdict(findings), context: diffContext, findings }, null, 2))
    process.exit(verdict(findings) === 'PASS' ? 0 : 2)
  }
  console.log(renderTerminal(findings, diffContext))
  process.exit(verdict(findings) === 'PASS' ? 0 : 2)
}

if (cmd === 'pull') {
  const host = opt('host', '192.168.43.1:5555')
  const out = opt('out', 'pulled')
  try {
    execFileSync('adb', ['connect', host], { stdio: 'inherit' })
    mkdirSync(out, { recursive: true })
    execFileSync('adb', ['pull', '/sdcard/FIRST/', out], { stdio: 'inherit' })
    console.log(`\nPulled hub files → ${out}/ — your active config XML is in there. Next: physync check --config ${out}/FIRST/<name>.xml --code <TeamCodeDir>`)
    process.exit(0)
  } catch (e) {
    die(e.code === 'ENOENT'
      ? 'adb not found — install Android platform-tools, or copy the config XML off the hub manually.'
      : `adb failed (${e.message}) — is the laptop on the robot's Wi-Fi? Default host is 192.168.43.1:5555.`)
  }
}

die(usage)
