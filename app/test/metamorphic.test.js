// Relational test suites — the kind of tests that assert a PROPERTY across
// transformed inputs, not a single input→output pair. Three axes the example
// and fuzz suites don't touch:
//
//   METAMORPHIC — transform the input in a way that should/shouldn't change
//     the output, and assert the relation (rename-invariance, reorder-
//     invariance, unrelated-addition monotonicity, whitespace-invariance,
//     comment-removal exactness). Catches bugs where the answer is right by
//     luck on the example but wrong under a structure-preserving change.
//   DIFFERENTIAL — two independent code paths that must agree on the same
//     input (dir-walk vs in-memory scan; CLI vs library core). Catches drift
//     between surfaces that each look correct alone.
//   STATEFUL — snapshot → mutate → diff round-trips: exactly one mutation
//     must produce exactly its drift and nothing else. Catches over- and
//     under-reporting in the temporal path.
//
// All driven off a STRUCTURED model generator (below) so transformations are
// exact model edits, then rendered to real XML/code and run through the real
// parse → scan → reconcile → snapshot pipeline.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfigXml, toSnapshot } from '../src/configXml.js'
import { scanSources, scanCodeDir } from '../src/codeScan.js'
import { reconcile, diffSnapshot, verdict } from '../src/engine.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ── Structured model generator ─────────────────────────────────────────────
// Produces valid, unique-named configs so transformations have unambiguous
// targets. Space→port ranges leave headroom so a free port always exists.
const SPACES = [
  { tag: 'Motor', space: 'motor', max: 3 },
  { tag: 'Servo', space: 'servo', max: 5 },
  { tag: 'RevTouchSensor', space: 'digital', max: 7 },
  { tag: 'AnalogInput', space: 'analog', max: 3 },
]
function genModel(rnd) {
  let gid = 0
  const portal = { name: 'Portal', serial: `SN${Math.floor(rnd() * 1e6)}`, addr: 173, hubs: [] }
  const hubCount = 1 + (rnd() < 0.5 ? 1 : 0)
  for (let h = 0; h < hubCount; h++) {
    const hub = { name: `Hub${h}`, addr: h === 0 ? 173 : 2, devices: [] }
    const usedPerSpace = new Map()
    const n = 1 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) {
      const s = SPACES[Math.floor(rnd() * SPACES.length)]
      const used = usedPerSpace.get(s.space) ?? new Set()
      let port = 0
      while (used.has(port) && port <= s.max) port++
      if (port > s.max) continue // this space full in this hub; skip
      used.add(port); usedPerSpace.set(s.space, used)
      hub.devices.push({ tag: s.tag, space: s.space, name: `dev_${gid++}`, port, referenced: rnd() < 0.6 })
    }
    portal.hubs.push(hub)
  }
  const model = { portal, ghost: rnd() < 0.5 ? `ghost_${Math.floor(rnd() * 1e4)}` : null }
  // ~40% of models carry a cross-file constant collision: file A's own value
  // names a REAL device, file B's names a ghost. Correct (file-local-wins)
  // resolution → no finding; last-wins resolution → a spurious
  // code-name-missing whose presence flips with file order.
  const devs = allDevices(model)
  if (devs.length && rnd() < 0.4) {
    model.collision = { aValue: devs[Math.floor(rnd() * devs.length)].name, bValue: `collision_ghost_${Math.floor(rnd() * 1e4)}` }
  }
  return model
}
const allDevices = (m) => m.portal.hubs.flatMap((h) => h.devices)

function renderXml(m) {
  const hubs = m.portal.hubs.map((h) =>
    `<LynxModule name="${h.name}" port="${h.addr}">` +
    h.devices.map((d) => `<${d.tag} name="${d.name}" port="${d.port}" />`).join('') +
    `</LynxModule>`).join('')
  return `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="${m.portal.name}" serialNumber="${m.portal.serial}" parentModuleAddress="${m.portal.addr}">${hubs}</LynxUsbDevice></Robot>`
}
// Code split across up to two files; each referenced device + optional ghost
// becomes one hardwareMap literal lookup.
function renderCodeFiles(m, { withGhost = true } = {}) {
  const refs = allDevices(m).filter((d) => d.referenced).map((d) => d.name)
  if (withGhost && m.ghost) refs.push(m.ghost)
  const half = Math.ceil(refs.length / 2)
  const mk = (names, cls, extra = '') => `public class ${cls} {\n${extra}` + names.map((n) => `  x = hardwareMap.get(DcMotorEx.class, "${n}");`).join('\n') + '\n}'
  // m.collision (when present) makes BOTH files declare the same constant
  // name with DIFFERENT values, and file A use it. Only file-local precedence
  // yields an order-independent answer — without it the verdict depends on
  // which file the scanner reads first (the round-3 P0 class). A mutation
  // test proved this dimension was missing from the generator.
  const aExtra = m.collision ? `  public static final String SHARED = "${m.collision.aValue}";\n  y = hardwareMap.get(DcMotorEx.class, SHARED);\n` : ''
  const bExtra = m.collision ? `  public static final String SHARED = "${m.collision.bValue}";\n` : ''
  const files = [{ name: 'A.java', content: mk(refs.slice(0, half), 'A', aExtra) }]
  if (refs.length > half || m.collision) files.push({ name: 'B.java', content: mk(refs.slice(half), 'B', bExtra) })
  return files
}
const namesOf = (m) => new Set([...allDevices(m).map((d) => d.name)])
const spaceMap = (m) => new Map(allDevices(m).map((d) => [d.name, d.space]))

function run(m, files) {
  const config = parseConfigXml(renderXml(m))
  const code = scanSources(files ?? renderCodeFiles(m), namesOf(m), spaceMap(m))
  return { config, findings: reconcile(config, code) }
}
const key = (f) => `${f.checkId}::${f.message}`
const multiset = (fs) => fs.map(key).sort()
// INDEPENDENT verdict oracle. Never assert verdict(x) === verdict(y) — that
// compares the implementation to itself and survives a "verdict always PASS"
// mutant (caught by mutation testing). Derive the expectation from severities.
const expectedVerdict = (findings) => (findings.some((f) => f.severity === 'FAIL') ? 'FAIL' : 'PASS')

// ── METAMORPHIC ─────────────────────────────────────────────────────────────
for (let seed = 1; seed <= 100; seed++) {
  const rnd = mulberry32(seed)
  const m = genModel(rnd)
  const base = run(m)
  const ctx = `seed ${seed}`

  test(`metamorphic ${seed}: consistent rename preserves verdict and finding shape`, () => {
    const devs = allDevices(m)
    if (!devs.length) return
    const target = devs[Math.floor(rnd() * devs.length)]
    const fresh = `renamed_unique_${seed}`
    const m2 = structuredClone(m)
    for (const d of allDevices(m2)) if (d.name === target.name) d.name = fresh
    // A *consistent* rename must update every reference to that name,
    // including the collision constant's value — otherwise the transformation
    // itself introduces a dangling reference and the property is untestable.
    if (m2.collision?.aValue === target.name) m2.collision.aValue = fresh
    const after = run(m2)
    // Names change, so messages change — but the SHAPE (which checks fired,
    // how many, and the verdict) must be identical under a consistent rename.
    assert.equal(verdict(after.findings), expectedVerdict(after.findings), `${ctx}: verdict disagrees with severity oracle`)
    assert.equal(verdict(after.findings), expectedVerdict(base.findings), `${ctx}: verdict changed under rename`)
    assert.deepEqual(multiset(after.findings.map((f) => ({ ...f, message: '' }))),
      multiset(base.findings.map((f) => ({ ...f, message: '' }))), `${ctx}: checkId multiset changed under rename`)
  })

  test(`metamorphic ${seed}: reordering source files never changes the finding set`, () => {
    const files = renderCodeFiles(m)
    if (files.length < 2) return
    const forward = reconcile(parseConfigXml(renderXml(m)), scanSources(files, namesOf(m), spaceMap(m)))
    const reversed = reconcile(parseConfigXml(renderXml(m)), scanSources([...files].reverse(), namesOf(m), spaceMap(m)))
    assert.deepEqual(multiset(reversed), multiset(forward), `${ctx}: file order changed the verdict — the round-3 P0 class`)
  })

  test(`metamorphic ${seed}: adding an unrelated device never removes an existing finding`, () => {
    const m2 = structuredClone(m)
    // Fresh second portal + hub — every port free, no possible collision.
    m2.portal2 = true
    const xml = renderXml(m).replace('</Robot>',
      '<LynxUsbDevice name="Extra" serialNumber="EXTRA" parentModuleAddress="5"><LynxModule name="ExtraHub" port="5"><Motor name="fresh_extra_dev" port="0" /></LynxModule></LynxUsbDevice></Robot>')
    const files = renderCodeFiles(m)
    files.push({ name: 'Extra.java', content: 'public class Extra {\n  x = hardwareMap.get(DcMotorEx.class, "fresh_extra_dev");\n}' })
    const names = new Set([...namesOf(m), 'fresh_extra_dev'])
    const after = reconcile(parseConfigXml(xml), scanSources(files, names, spaceMap(m)))
    const afterSet = new Set(multiset(after))
    for (const f of base.findings) assert.ok(afterSet.has(key(f)), `${ctx}: adding an unrelated device removed finding: ${key(f)}`)
  })

  test(`metamorphic ${seed}: whitespace and comment injection in code changes nothing`, () => {
    const files = renderCodeFiles(m).map((f) => ({
      name: f.name,
      content: `/* generated header ${seed} */\n\n` + f.content.replace(/;\n/g, ';\n\n   \n'),
    }))
    const after = reconcile(parseConfigXml(renderXml(m)), scanSources(files, namesOf(m), spaceMap(m)))
    assert.deepEqual(multiset(after), multiset(base.findings), `${ctx}: formatting changed the findings`)
  })

  test(`metamorphic ${seed}: commenting out a ghost lookup removes exactly that finding`, () => {
    if (!m.ghost) return
    const ghostKeyPresent = base.findings.some((f) => f.checkId === 'code-name-missing' && f.message.includes(m.ghost))
    assert.ok(ghostKeyPresent, `${ctx}: precondition — ghost should produce a missing finding`)
    const files = renderCodeFiles(m).map((f) => ({
      name: f.name,
      content: f.content.replace(new RegExp(`^.*"${m.ghost}".*$`, 'm'), '  // removed'),
    }))
    const after = reconcile(parseConfigXml(renderXml(m)), scanSources(files, namesOf(m), spaceMap(m)))
    const removed = multiset(base.findings).filter((k) => !new Set(multiset(after)).has(k))
    assert.equal(removed.length, 1, `${ctx}: expected exactly one finding removed, got ${removed.length}`)
    assert.ok(removed[0].includes(m.ghost), `${ctx}: the wrong finding was removed`)
  })
}

// ── DIFFERENTIAL ─────────────────────────────────────────────────────────────
for (let seed = 1; seed <= 100; seed++) {
  test(`differential ${seed}: dir-walk scan ≡ in-memory scan (same names, same dynamics)`, () => {
    const m = genModel(mulberry32(seed * 7 + 1))
    const files = renderCodeFiles(m)
    const dir = mkdtempSync(join(tmpdir(), `physync-diff-${seed}-`))
    for (const f of files) writeFileSync(join(dir, f.name), f.content)
    const names = namesOf(m)
    const inMem = scanSources(files, names, spaceMap(m))
    const onDisk = scanCodeDir(dir, names, spaceMap(m))
    assert.deepEqual(onDisk.refs.map((r) => r.name).sort(), inMem.refs.map((r) => r.name).sort(), `seed ${seed}: refs differ between surfaces`)
    assert.equal(onDisk.dynamic.length, inMem.dynamic.length, `seed ${seed}: dynamic count differs`)
    assert.equal(onDisk.filesScanned, inMem.filesScanned, `seed ${seed}: file count differs`)
  })
}

for (let seed = 1; seed <= 20; seed++) {
  test(`differential ${seed}: CLI --json ≡ library core (verdict + finding multiset)`, () => {
    const m = genModel(mulberry32(seed * 13 + 5))
    const files = renderCodeFiles(m)
    const dir = mkdtempSync(join(tmpdir(), `physync-cli-${seed}-`))
    writeFileSync(join(dir, 'config.xml'), renderXml(m))
    mkdirSync(join(dir, 'code'))
    for (const f of files) writeFileSync(join(dir, 'code', f.name), f.content)
    let cliOut
    try {
      cliOut = execFileSync(process.execPath, [join(APP, 'bin/physync.js'), 'check', '--config', 'config.xml', '--code', 'code', '--json'], { cwd: dir, encoding: 'utf8' })
    } catch (e) { cliOut = String(e.stdout ?? '') } // exit 2 on FAIL still prints JSON
    const cli = JSON.parse(cliOut)
    const core = run(m)
    // Oracle first (catches a broken verdict function), then cross-surface agreement.
    assert.equal(cli.verdict, expectedVerdict(core.findings), `seed ${seed}: CLI verdict disagrees with severity oracle`)
    assert.equal(verdict(core.findings), expectedVerdict(core.findings), `seed ${seed}: core verdict disagrees with severity oracle`)
    assert.deepEqual(multiset(cli.findings), multiset(core.findings), `seed ${seed}: finding multiset differs CLI vs core`)
  })
}

// ── STATEFUL (snapshot → mutate → diff) ──────────────────────────────────────
for (let seed = 1; seed <= 100; seed++) {
  const rnd = mulberry32(seed * 3 + 2)
  const m = genModel(rnd)
  const snap = toSnapshot(parseConfigXml(renderXml(m)))
  const ctx = `seed ${seed}`
  const devs = allDevices(m)

  test(`stateful ${seed}: diff of a config against its own snapshot is empty (idempotence)`, () => {
    assert.deepEqual(diffSnapshot(snap, toSnapshot(parseConfigXml(renderXml(m)))), [], `${ctx}: self-diff not empty`)
  })

  test(`stateful ${seed}: moving one device to a free port yields exactly one 'moved' drift`, () => {
    if (!devs.length) return
    const m2 = structuredClone(m)
    const target = allDevices(m2)[0]
    const s = SPACES.find((x) => x.space === target.space)
    const hub = m2.portal.hubs.find((h) => h.devices.includes(target))
    const used = new Set(hub.devices.filter((d) => d.space === target.space).map((d) => d.port))
    let free = -1
    for (let p = 0; p <= s.max; p++) if (!used.has(p)) { free = p; break }
    if (free === -1) return // space full — no unambiguous free port
    target.port = free
    const findings = diffSnapshot(snap, toSnapshot(parseConfigXml(renderXml(m2))))
    assert.equal(findings.length, 1, `${ctx}: expected exactly 1 drift, got ${findings.length}`)
    assert.match(findings[0].message, /moved/)
    assert.ok(findings[0].message.includes(target.name))
  })

  test(`stateful ${seed}: removing one device yields exactly one 'removed' drift`, () => {
    if (devs.length < 2) return
    const m2 = structuredClone(m)
    const hub = m2.portal.hubs.find((h) => h.devices.length)
    const removed = hub.devices.pop()
    const findings = diffSnapshot(snap, toSnapshot(parseConfigXml(renderXml(m2))))
    assert.equal(findings.length, 1, `${ctx}: expected exactly 1 removed drift, got ${findings.length}`)
    assert.match(findings[0].message, /removed/)
    assert.ok(findings[0].message.includes(removed.name))
  })

  test(`stateful ${seed}: swapping the portal serial yields exactly one 'serial changed' drift`, () => {
    const m2 = structuredClone(m)
    m2.portal.serial = `${m.portal.serial}_SWAPPED`
    const findings = diffSnapshot(snap, toSnapshot(parseConfigXml(renderXml(m2))))
    assert.equal(findings.length, 1, `${ctx}: expected exactly 1 serial drift, got ${findings.length}`)
    assert.match(findings[0].message, /serial changed/)
  })
}
