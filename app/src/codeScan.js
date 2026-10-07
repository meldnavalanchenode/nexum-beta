// TeamCode scanner — extracts every hardware-device name the code expects.
// Hardened by three QA rounds against how real teams actually write code:
//   - wrapper classes: ANY receiver counts for the distinctive class-typed
//     forms (hw.get(DcMotorEx.class, "x")) — `X.class, "string"` is
//     unmistakably an SDK lookup
//   - Kotlin: .kt files scanned; `::class.java` form matched
//   - constants: `static final String LEFT = "left_drive"` resolved with
//     file-local definitions outranking cross-file ones; same-named constants
//     with DIFFERENT values across files are ambiguous and fall to
//     dynamic-name (round-3 P0: last-wins resolution made the VERDICT depend
//     on file order — a wrong PASS)
//   - comments: // and /* */ stripped (newline-preserving) so dead code
//     can't cause false FAILs
//   - dynamic names ("module" + i + "_motor"): reported as unverifiable,
//     never guessed at
//   - Blocks (.blk): scanned via the identifier convention — matched names
//     credit usage, stale/type-mismatched IDENTIFIER fields WARN, and Blocks
//     evidence never produces a FAIL (convention unverified vs SDK source)

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { sanitizeLine } from './text.js'

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex')

// Class-typed lookups, any receiver: x.get(Type.class, …) / x.tryGet(…) /
// Kotlin x.get(Type::class.java, …). Name argument: literal or identifier.
const CLASS_FORM = /([A-Za-z_$][\w$]*)\s*\.\s*(get|tryGet)\s*\(\s*([A-Za-z_][\w.]{0,80}?)\s*(?:\.\s*class|::\s*class\s*\.\s*java)\s*,\s*(?:"([^"\r\n]{0,300})"|([A-Za-z_$][\w$.]*))/g
// Typed device mappings: x.dcMotor.get("n") etc.
const TYPED_MAP = /([A-Za-z_$][\w$]*)\s*\.\s*(dcMotor|servo|crservo|colorSensor|touchSensor|gyroSensor|analogInput|digitalChannel|led|lightSensor|ultrasonicSensor|voltageSensor|irSeekerSensor|accelerationSensor|compassSensor)\s*\.\s*get\s*\(\s*(?:"([^"\r\n]{0,300})"|([A-Za-z_$][\w$.]*))/g
// Bare string form, restricted to hardwareMap-ish receivers (any .get("s") is too generic).
const BARE_FORM = /\b(hardwareMap|hwMap)\s*\.\s*(get|tryGet)\s*\(\s*"([^"\r\n]{0,300})"/g
const CONSTANT = /(?:static\s+final|final\s+static|const\s+val)\s+(?:String\s+)?([A-Za-z_$][\w$]*)\s*=\s*"([^"\r\n]{0,300})"/g
// Numeric constants, for `claw.setPosition(CLAW_OPEN)` where CLAW_OPEN = 1.5.
const NUM_CONSTANT = /(?:static\s+final|final\s+static|const\s+val)\s+(?:double|float|Double|Float)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*\w+\s*)?=\s*(-?\d{0,12}\.?\d{1,12})\s*[fF]?\s*[;\n]/g
// `Servo claw = hardwareMap.get(Servo.class, "claw");` → binds claw ↔ "claw",
// and records which CLASS the code asked for (used for the class-mismatch check).
// Handles the three declaration shapes that were previously missed entirely:
//   Java field assignment   this.claw = hardwareMap.get(...)
//   Kotlin typed val        val claw: Servo = hardwareMap.get(...)
//   Kotlin inferred val     val claw = hardwareMap.get(...)
// Each miss was a silent wrong PASS: the official FTC hardware-class pattern
// (this.field) got no servo checking at all.
const VAR_BINDING = /(?:^|[\s;{(])(?:(?:private|public|protected|final|val|var|static)\s+){0,5}(?:[A-Za-z_$][\w$.<>]{0,80}\s+)?(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$.<>?]*\s*)?=\s*[A-Za-z_$][\w$.]*\s*\.\s*(?:get|tryGet)\s*\(\s*([A-Za-z_][\w.]{0,80}?)\s*(?:\.\s*class|::\s*class\s*\.\s*java)\s*,\s*(?:"([^"\r\n]{0,300})"|([A-Za-z_$][\w$.]*))\s*\)/g
// Servo commands on a bound variable. The argument list is captured with a
// balanced-paren scan, not `[^)]*` — that truncated at the FIRST ')' and
// spliced a nested call's arguments in, false-FAILing the canonical
// Range.scale(...) idiom.
const SERVO_CALL_HEAD = /(?:^|[^\w$.])(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*(setPosition|scaleRange)\s*\(/g
// The one-liner form: hardwareMap.get(Servo.class, "claw").setPosition(1.4).
// It binds no variable, so the binding-based scan above never saw it, and every
// servo check silently skipped a file written this way — a wrong PASS.
const CHAINED_SERVO_CALL = /[A-Za-z_$][\w$.]{0,80}\s*\.\s*(?:get|tryGet)\s*\(\s*([A-Za-z_][\w.]{0,80}?)\s*(?:\.\s*class|::\s*class\s*\.\s*java)\s*,\s*"([^"\r\n]{0,300})"\s*\)\s*\.\s*(setPosition|scaleRange)\s*\(/g

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, ' ')

/** Comments AND string literals blanked (length-preserving, so indices and
 *  line numbers stay true). Servo-call scanning needs this: a call written
 *  inside a string — a log line, a doc example — produced a real FAIL. Device
 *  lookups deliberately do NOT use this, since their argument IS a string. */
const stripCommentsAndStrings = (src) => stripComments(src)
  .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`)

const lineCounter = (src) => {
  let cursor = 0
  let line = 1
  return (idx) => {
    for (; cursor < idx; cursor++) if (src.charCodeAt(cursor) === 10) line++
    return line
  }
}

export function collectConstants(source) {
  const map = new Map()
  for (const m of stripComments(source).matchAll(CONSTANT)) map.set(m[1], m[2])
  return map
}

/** Numeric constants, keyed BOTH bare and class-qualified. Resolving only the
 *  bare simple name let `Claw.HOME` silently pick up an unrelated `Winch.HOME`
 *  and produce a false FAIL. The qualified key is preferred at lookup time. */
export function collectNumericConstants(source, className = null) {
  const src = stripComments(source)
  const cls = className ?? (src.match(/\b(?:class|object)\s+([A-Za-z_$][\w$]*)/)?.[1] ?? null)
  const map = new Map()
  const ambiguous = new Set()
  for (const m of src.matchAll(NUM_CONSTANT)) {
    const value = Number(m[2])
    if (map.has(m[1]) && map.get(m[1]) !== value) ambiguous.add(m[1])
    map.set(m[1], value)
    if (cls) map.set(`${cls}.${m[1]}`, value)
  }
  // A bare name defined twice with different values cannot be resolved safely.
  for (const k of ambiguous) map.delete(k)
  return map
}

/** Servo commands, resolved back to the device name they act on.
 *  Returns [{device, method, args, requestedClass, file, line}]. An argument
 *  that isn't a literal or a known numeric constant becomes null — reported as
 *  unverifiable rather than guessed, same rule as dynamic device names. */
/** Reads a balanced argument list starting just after an opening paren.
 *  Returns the raw argument strings, or null if the list never closes. */
function readArgs(src, openIndex) {
  let depth = 1
  let i = openIndex
  const args = []
  let current = ''
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) break }
    if (depth === 1 && ch === ',') { args.push(current); current = '' } else if (depth > 0) current += ch
    i++
  }
  if (depth !== 0) return null
  if (current.trim() || args.length) args.push(current)
  return { args, end: i }
}

/** A literal, or a known constant, or null. Never a guess. */
function resolveNumeric(raw, numericConstants) {
  const t = raw.trim()
  // Strip a float/double suffix only from a NUMERIC literal — applying it to
  // identifiers turned every constant ending in d/D/f/F unresolvable.
  const numeric = t.replace(/^([-+]?\d*\.?\d+)[fFdD]$/, '$1')
  if (/^[-+]?\d*\.?\d+$/.test(numeric)) return Number(numeric)
  if (numericConstants.has(t)) return numericConstants.get(t)              // qualified: Claw.HOME
  const bare = t.split('.').pop()
  if (!t.includes('.') && numericConstants.has(bare)) return numericConstants.get(bare)
  return null
}

export function scanServoUsage(source, file, numericConstants = new Map(), stringConstants = new Map()) {
  // Bindings are found in the comment-stripped source (their argument is a
  // string), but CALLS are scanned with strings blanked too, so a servo command
  // written inside a string literal cannot produce a finding.
  const src = stripComments(source)
  const callSrc = stripCommentsAndStrings(source)

  const bindings = new Map()   // variable → { device, requestedClass }
  const rebound = new Set()
  for (const m of src.matchAll(VAR_BINDING)) {
    // A device name supplied through a String constant is resolved the same way
    // device lookups already resolve it.
    const device = m[3] ?? stringConstants.get(m[4]?.split('.').pop() ?? '') ?? null
    if (device == null) continue
    const prior = bindings.get(m[1])
    // Reusing a local name (`Servo s`) in two methods previously erased the
    // earlier device's checks entirely. Ambiguous names are dropped rather than
    // silently resolved to the last one seen.
    if (prior && prior.device !== device) { rebound.add(m[1]); continue }
    bindings.set(m[1], { device, requestedClass: m[2].split('.').pop() })
  }
  for (const name of rebound) bindings.delete(name)

  const lineOf = lineCounter(callSrc)
  const calls = []
  const unresolved = []
  for (const m of callSrc.matchAll(SERVO_CALL_HEAD)) {
    const variable = m[1]
    const open = m.index + m[0].length
    const parsed = readArgs(callSrc, open)
    if (!parsed) continue
    const line = lineOf(m.index)
    const bound = bindings.get(variable)
    if (!bound) {
      // Silence here is indistinguishable from "checked and fine", so a call we
      // cannot trace to a device is reported as unverifiable.
      if (rebound.has(variable)) {
        unresolved.push({ variable, reason: `"${variable}" is bound to more than one device in this file`, file, line })
      }
      continue
    }
    const args = parsed.args.map((a) => resolveNumeric(a, numericConstants))
    calls.push({ device: bound.device, requestedClass: bound.requestedClass, method: m[2], args, file, line })
  }

  // Chained calls are matched in `src` because the device name IS a string; an
  // occurrence inside a string literal is then rejected by checking the same
  // offsets in the blanked copy (both transforms are length-preserving).
  const chainLine = lineCounter(src)
  const chained = []
  for (const m of src.matchAll(CHAINED_SERVO_CALL)) {
    if (!callSrc.slice(m.index, m.index + m[0].length).includes(`.${m[3]}`)) continue
    const parsed = readArgs(callSrc, m.index + m[0].length)
    if (!parsed) continue
    const requestedClass = m[1].split('.').pop()
    calls.push({
      device: m[2],
      requestedClass,
      method: m[3],
      args: parsed.args.map((a) => resolveNumeric(a, numericConstants)),
      file,
      line: chainLine(m.index),
    })
    chained.push({ variable: null, device: m[2], requestedClass, file })
  }

  return {
    bindings: [...bindings.entries()].map(([v, b]) => ({ variable: v, ...b, file })).concat(chained),
    calls,
    unresolved,
  }
}

export function scanJavaSource(source, file, constants = new Map()) {
  const src = stripComments(source)
  // Collect candidates from all three shapes first, then process in source
  // order with ONE forward-only line counter (a shared counter across
  // interleaved passes reported wrong lines — caught by the test suite).
  const candidates = []
  for (const m of src.matchAll(CLASS_FORM)) candidates.push({ index: m.index, end: m.index + m[0].length, name: m[4] ?? null, ident: m[5], via: m[3] })
  for (const m of src.matchAll(TYPED_MAP)) candidates.push({ index: m.index, end: m.index + m[0].length, name: m[3] ?? null, ident: m[4], via: m[2] })
  // BARE_FORM requires a string literal directly after '(' so it never
  // overlaps the class-typed form — no dedup needed.
  for (const m of src.matchAll(BARE_FORM)) candidates.push({ index: m.index, end: m.index + m[0].length, name: m[3], ident: null, via: m[2] })
  candidates.sort((a, b) => a.index - b.index)

  const refs = []
  const dynamic = []
  const lineOf = lineCounter(src)
  const isDynamic = (end) => /^\s*\+/.test(src.slice(end))
  for (const c of candidates) {
    const line = lineOf(c.index)
    if (c.name != null) {
      // A source FILE can carry raw control bytes inside a string literal —
      // the newline exclusion in the regexes doesn't cover ESC and friends.
      // Names are data; data does not get to move the cursor.
      if (isDynamic(c.end)) dynamic.push({ expr: `"${sanitizeLine(c.name)}" + …`, file, line })
      else refs.push({ name: sanitizeLine(c.name), via: c.via, file, line })
      continue
    }
    // Identifier argument — resolve via constants (last segment for
    // qualified names like DriveConstants.LEFT).
    const key = c.ident.split('.').pop()
    if (constants.has(key)) refs.push({ name: sanitizeLine(constants.get(key)), via: `${c.via} (const ${c.ident})`, file, line })
    else dynamic.push({ expr: c.ident, file, line })
  }
  return { refs, dynamic }
}

// Blocks (.blk) scanning — deliberately conservative. Blockly XML hardware
// blocks carry identifier fields derived from config device names (commonly
// name + "As" + type, e.g. "left_driveAsDcMotor"). The convention is
// verified against real team .blk files (2026-09-07 corpus: every real
// IDENTIFIER extracted, credit and stale paths both correct) though not
// against SDK generation source, so Blocks evidence
// NEVER produces a FAIL — matches credit usage, mismatches only WARN.
const BLK_FIELD = /<field[^>]*?name="([^"\r\n]{0,300})"[^>]*>([^<]{1,80})<\/field>/g
const AS_SUFFIX = /^(.+?)As([A-Z]\w*)$/

const impliedSpace = (typeToken) => {
  if (/Servo/i.test(typeToken)) return 'servo'
  if (/Motor/i.test(typeToken)) return 'motor'
  return null
}

export function scanBlkSource(source, file, configNames, spaceByName = new Map()) {
  const refs = []
  const unknown = []
  const seenRef = new Set()
  const seenUnknown = new Set()
  for (const m of source.matchAll(BLK_FIELD)) {
    const fieldName = m[1]
    const value = m[2].trim()
    if (!value) continue
    // Dedupe PER OUTCOME, and only after classifying — a Blockly variable
    // holding the same string must not consume a later real IDENTIFIER field
    // (round-3 P1: order-dependent WARN suppression).
    if (configNames.has(value)) {
      if (!seenRef.has(value)) { seenRef.add(value); refs.push({ name: value, via: 'blocks', file }) }
      continue
    }
    const suffix = value.match(AS_SUFFIX)
    if (!suffix) continue
    const [, base, typeToken] = suffix
    if (configNames.has(base)) {
      if (!seenRef.has(base)) { seenRef.add(base); refs.push({ name: base, via: 'blocks', file }) }
      // Type-mismatch stale case (round-3 P2): "armAsDcMotor" against a
      // configured Servo "arm" means the device was re-typed after the
      // OpMode was written. Only the high-confidence motor↔servo crossing
      // warns; anything subtler stays silent (convention uncertainty).
      const implied = impliedSpace(typeToken)
      const configured = spaceByName.get(base)
      if (implied && (configured === 'motor' || configured === 'servo') && implied !== configured
          && /IDENTIFIER/i.test(fieldName) && !seenUnknown.has(value)) {
        seenUnknown.add(value)
        unknown.push({ identifier: value, base, file, kind: 'type-mismatch', configured })
      }
      continue
    }
    // Stale-identifier WARNs come ONLY from IDENTIFIER-named fields — a
    // Blockly variable someone happened to call "countAsDcMotor" must not
    // produce a warning (hard-test lens: false-WARN hunting).
    if (/IDENTIFIER/i.test(fieldName) && !seenUnknown.has(value)) {
      seenUnknown.add(value)
      unknown.push({ identifier: value, base, file, kind: 'stale' })
    }
  }
  return { refs, unknown }
}

/** In-memory scan over [{name, content}] — shared by the dir walker and the
 *  web UI so both paths run identical logic. */
export function scanSources(files, configNames = new Set(), spaceByName = new Map()) {
  const javaish = files.filter((f) => /\.(java|kt)$/.test(f.name))
  const blks = files.filter((f) => f.name.endsWith('.blk'))
  // A CONTENT fingerprint of everything actually scanned. git is not enough:
  // most FTC teams edit without committing (and many TeamCode folders are not
  // repos at all), so a code-only change — the commonest real change there is
  // — went completely undetected and status answered "0 change(s)".
  const codeDigest = sha256(
    [...javaish, ...blks]
      .map((f) => `${f.name} ${sha256(f.content)}`)
      .sort()
      .join(''),
  )

  // Constant resolution, order-independent (round-3 P0): a file's own
  // constants always win; a cross-file constant is usable only when every
  // file that defines that name agrees on the value — otherwise it is
  // ambiguous and identifier refs to it fall to dynamic-name.
  const perFile = new Map()
  const global = new Map()
  const conflicted = new Set()
  for (const f of javaish) {
    const locals = collectConstants(f.content)
    perFile.set(f.name, locals)
    for (const [k, v] of locals) {
      if (global.has(k) && global.get(k) !== v) conflicted.add(k)
      else global.set(k, v)
    }
  }

  // Numeric constants follow the same file-local-wins rule as string ones.
  const perFileNums = new Map()
  const globalNums = new Map()
  const conflictedNums = new Set()
  for (const f of javaish) {
    const locals = collectNumericConstants(f.content)
    perFileNums.set(f.name, locals)
    for (const [k, v] of locals) {
      if (globalNums.has(k) && globalNums.get(k) !== v) conflictedNums.add(k)
      else globalNums.set(k, v)
    }
  }

  const refs = []
  const dynamic = []
  const blocksUnknown = []
  const servoCalls = []
  const servoBindings = []
  for (const f of javaish) {
    const locals = perFile.get(f.name)
    const effective = new Map()
    for (const [k, v] of global) if (!conflicted.has(k)) effective.set(k, v)
    for (const [k, v] of locals) effective.set(k, v) // locals outrank, even when globally conflicted
    const out = scanJavaSource(f.content, f.name, effective)
    refs.push(...out.refs)
    dynamic.push(...out.dynamic)

    const effectiveNums = new Map()
    for (const [k, v] of globalNums) if (!conflictedNums.has(k)) effectiveNums.set(k, v)
    for (const [k, v] of perFileNums.get(f.name)) effectiveNums.set(k, v)
    const servo = scanServoUsage(f.content, f.name, effectiveNums, effective)
    servoCalls.push(...servo.calls)
    servoBindings.push(...servo.bindings)
    for (const u of servo.unresolved ?? []) dynamic.push({ expr: u.reason, file: u.file, line: u.line })
  }
  for (const f of blks) {
    const out = scanBlkSource(f.content, f.name, configNames, spaceByName)
    refs.push(...out.refs)
    blocksUnknown.push(...out.unknown)
  }
  return { refs, dynamic, blocksUnknown, servoCalls, servoBindings, filesScanned: javaish.length, blkCount: blks.length, unreadable: [], codeDigest }
}

export function scanCodeDir(dir, configNames = new Set(), spaceByName = new Map()) {
  const paths = []
  const unreadable = []
  const visited = new Set() // realpaths — symlink cycles must not rescan (round-3 P2)
  const walk = (d) => {
    let real
    try { real = realpathSync(d) } catch { unreadable.push(basename(d)); return }
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try { entries = readdirSync(d) } catch { unreadable.push(basename(d)); return } // round-3 P1: no raw stack trace
    for (const entry of entries) {
      const p = join(d, entry)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else if (/\.(java|kt|blk)$/.test(entry)) paths.push(p)
    }
  }
  walk(dir)
  const files = []
  for (const p of paths) {
    try { files.push({ name: p, content: readFileSync(p, 'utf8') }) } catch { unreadable.push(basename(p)) }
  }
  const out = scanSources(files, configNames, spaceByName)
  out.unreadable = unreadable
  return out
}
