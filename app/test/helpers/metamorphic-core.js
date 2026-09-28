// Metamorphic core — causality scenarios shared by the metamorphic shard
// files. One cause → exactly that finding, naming the thing that moved.
// See metamorphic-gate.test.js for the property description.

import test from 'node:test'
import assert from 'node:assert/strict'
import { compareApproval, validateApproval } from '../../src/approval.js'
import { checkMeta } from '../../src/registry.js'
import { verdict } from '../../src/engine.js'
import { mulberry32, genApproval, genConfigXml, int, pick } from './gen.js'

const observe = (m, configXml, over = {}) => ({
  configName: over.configName ?? m.configName,
  configXml: over.configXml ?? configXml,
  hubs: over.hubs !== undefined ? over.hubs : m.hubs.map((h) => ({ ...h })),
})

const SCENARIOS = [
  {
    kind: 'control: unchanged robot stays clean',
    guard: () => true,
    run: (m, configXml) => {
      const f = compareApproval(m, observe(m, configXml), checkMeta)
      assert.deepEqual(f.filter((x) => x.severity === 'FAIL'), [], 'an unchanged robot must never FAIL the gate')
      if (!m.hubsVerified) assert.ok(f.some((x) => x.checkId === 'approval-hubs-not-covered'), 'the coverage gap must be stated')
    },
  },
  {
    kind: 'config renamed',
    guard: () => true,
    run: (m, configXml) => {
      const newName = m.configName + '_B'
      const f = compareApproval(m, observe(m, configXml, { configName: newName }), checkMeta)
      const drift = f.filter((x) => x.checkId === 'approval-config-drift')
      assert.equal(drift.length, 1, 'one rename, one finding')
      assert.ok(drift[0].message.includes(newName) && drift[0].message.includes(m.configName), 'both names must appear')
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'config content edited in place',
    guard: () => true,
    run: (m, configXml, rnd) => {
      const edited = configXml.replace('</LynxModule>', `<Motor name="sneaky_${int(rnd, 0, 99)}" port="3" /></LynxModule>`)
      assert.notEqual(edited, configXml)
      const f = compareApproval(m, observe(m, configXml, { configXml: edited }), checkMeta)
      const drift = f.filter((x) => x.checkId === 'approval-config-drift')
      assert.equal(drift.length, 1)
      assert.match(drift[0].message, /changed since it was approved/)
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'firmware spelling changes but version does not — must stay clean',
    guard: (m) => m.hubsVerified && m.hubs.some((h) => /^\d+\.\d+\.\d+$/.test(h.firmware)),
    run: (m, configXml) => {
      const hubs = m.hubs.map((h) => /^\d+\.\d+\.\d+$/.test(h.firmware)
        ? { ...h, firmware: `HW: 20, Maj: ${h.firmware.split('.')[0]}, Min: ${h.firmware.split('.')[1]}, Eng: ${h.firmware.split('.')[2]}` }
        : h)
      const f = compareApproval(m, observe(m, configXml, { hubs }), checkMeta)
      assert.deepEqual(f.filter((x) => x.severity === 'FAIL'), [], 'a spelling change is presentation, not drift — flagging it would be the false red light')
    },
  },
  {
    kind: 'firmware version actually changes',
    guard: (m) => m.hubsVerified && m.hubs.length > 0,
    run: (m, configXml, rnd) => {
      const target = pick(rnd, m.hubs)
      // Seed 84,794 of the million-test run: the generator had ALREADY given
      // this hub firmware "9.9.9", the scenario "changed" it to the same
      // version, and the gate correctly reported no drift — the test's
      // assumption was wrong, not the product. The replacement must be
      // guaranteed different from the target's current normalized value.
      const version = target.firmware === '9.9.9' ? '8.8.8' : '9.9.9'
      const [maj, min, eng] = version.split('.')
      const hubs = m.hubs.map((h) => h.address === target.address ? { ...h, firmware: `Maj: ${maj}, Min: ${min}, Eng: ${eng}` } : h)
      const f = compareApproval(m, observe(m, configXml, { hubs }), checkMeta)
      const drift = f.filter((x) => x.checkId === 'approval-hub-drift')
      assert.equal(drift.length, 1, 'one flash, one finding')
      assert.ok(drift[0].message.includes(`@${target.address}`), 'the message must name the hub')
      assert.ok(drift[0].message.includes(version))
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'a hub vanishes',
    guard: (m) => m.hubsVerified && m.hubs.length > 0,
    run: (m, configXml, rnd) => {
      const gone = pick(rnd, m.hubs)
      const f = compareApproval(m, observe(m, configXml, { hubs: m.hubs.filter((h) => h.address !== gone.address) }), checkMeta)
      const drift = f.filter((x) => x.checkId === 'approval-hub-drift')
      assert.equal(drift.length, 1)
      assert.ok(drift[0].message.includes(`@${gone.address}`))
      assert.match(drift[0].message, /not answering/)
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'a hub appears',
    guard: (m) => m.hubsVerified,
    run: (m, configXml, rnd) => {
      let address = int(rnd, 1, 255)
      while (m.hubs.some((h) => h.address === address)) address = (address % 255) + 1
      const f = compareApproval(m, observe(m, configXml, { hubs: [...m.hubs, { address, firmware: '1.8.2' }] }), checkMeta)
      const drift = f.filter((x) => x.checkId === 'approval-hub-drift')
      assert.equal(drift.length, 1)
      assert.ok(drift[0].message.includes(`@${address}`))
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'a hub is re-addressed — must surface as the vanish+appear pair',
    guard: (m) => m.hubsVerified && m.hubs.length > 0 && m.hubs.length < 254,
    run: (m, configXml, rnd) => {
      const target = pick(rnd, m.hubs)
      let next = int(rnd, 1, 255)
      while (m.hubs.some((h) => h.address === next)) next = (next % 255) + 1
      const hubs = m.hubs.map((h) => h.address === target.address ? { ...h, address: next } : h)
      const f = compareApproval(m, observe(m, configXml, { hubs }), checkMeta)
      const drift = f.filter((x) => x.checkId === 'approval-hub-drift')
      assert.equal(drift.length, 2, 're-addressing is a disappearance AND an apparition — both must be named')
      assert.ok(drift.some((x) => x.message.includes(`@${target.address}`)))
      assert.ok(drift.some((x) => x.message.includes(`@${next}`)))
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'compound: config edit + hub vanish — both causes named, neither masked',
    guard: (m) => m.hubsVerified && m.hubs.length > 0,
    run: (m, configXml, rnd) => {
      const gone = pick(rnd, m.hubs)
      const f = compareApproval(m, observe(m, configXml, {
        configXml: configXml + ' ',
        hubs: m.hubs.filter((h) => h.address !== gone.address),
      }), checkMeta)
      assert.ok(f.some((x) => x.checkId === 'approval-config-drift'), 'the config cause must survive the hub cause')
      assert.ok(f.some((x) => x.checkId === 'approval-hub-drift' && x.message.includes(`@${gone.address}`)))
      assert.equal(verdict(f), 'FAIL')
    },
  },
  {
    kind: 'observed hubs in shuffled order — order is never drift',
    guard: (m) => m.hubsVerified && m.hubs.length >= 2,
    run: (m, configXml) => {
      const f = compareApproval(m, observe(m, configXml, { hubs: [...m.hubs].reverse() }), checkMeta)
      assert.deepEqual(f.filter((x) => x.severity === 'FAIL'), [], 'enumeration order must never fire the gate')
    },
  },
]

export function runMetamorphicShard(from, to) {
  for (let seed = from; seed <= to; seed++) {
    const rnd = mulberry32(seed * 31)
    const configXml = genConfigXml(rnd)
    const m = genApproval(rnd, { configXml })
    const eligible = SCENARIOS.filter((s) => s.guard(m))
    const scenario = eligible[seed % eligible.length]
    test(`metamorphic-gate seed ${seed}: ${scenario.kind}`, () => {
      validateApproval(JSON.parse(JSON.stringify(m)))
      scenario.run(m, configXml, mulberry32(seed * 37))
    })
  }
}
