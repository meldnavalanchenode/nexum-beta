# Nexum

**When your robot changes, Nexum tells you which of your previous testing no
longer counts — and the minimum you must re-verify before trusting the robot
again.**

Works with FTC robots today (config XML + Java TeamCode). Runs entirely on
your laptop, offline. Reads files; **nothing ever runs on your robot.**

## Try it in 60 seconds (no robot needed)

Install [Node.js LTS](https://nodejs.org) if you don't have it, then:

```bash
node app/bin/physync.js check --config app/samples/config.xml --code app/samples/TeamCode
```

You'll see a deliberately broken sample robot FAIL, with each mismatch named
(including a did-you-mean for a typo'd device). If you see that banner, Nexum
works on your machine.

## Use it on YOUR robot (10 minutes)

**1 · Run the check on your real files** — config XML from your Robot
Controller (`/sdcard/FIRST/*.xml`, or ask us to pull it at a meet) plus your
TeamCode folder:

```bash
node app/bin/physync.js check --config yourconfig.xml --code YourTeamCode
```

It finds mismatches between what your code asks for and what your
configuration declares — or proves you clean, in about 3 seconds.

**2 · Save your baseline** (do this while everything works):

```bash
node app/bin/physync.js state --config yourconfig.xml --code YourTeamCode
```

That freezes a **verified state (V1)** — a permanent, tamper-evident record
of the robot you trust.

**3 · Next time ANYTHING changes** — part swap, port move, code refactor,
re-flash — run:

```bash
node app/bin/physync.js status --config yourconfig.xml --code YourTeamCode
```

Nexum compares against your baseline and tells you: **what changed, what
previous evidence that change put in question, and the minimum set of
re-checks owed** before the robot is back to verified.

Physical change no file can see (re-aimed camera, swapped wheels)? Tell
Nexum, with your name on it:

```bash
node app/bin/physync.js change --component camera-position --note "re-aimed the mount" --by yourName
```

Record a re-check you performed:

```bash
node app/bin/physync.js result --test localization --value 0.96 --by yourName
```

When everything owed is satisfied, save the new baseline (`state` again) —
that's V2, and your robot's history is now two links long. There's also a
local web view: `node app/src/server.js` → http://127.0.0.1:4620.

## Plain-language glossary

- **Verified state (V1, V2, …)** — a frozen, append-only snapshot of a robot
  a human vouched for. Never edited, never deleted; new verification makes a
  new version.
- **Evidence** — one recorded fact with its source and method attached
  ("config and code reconciled", "localization = 0.96, recorded by Sam").
- **PASS / FAIL / UNKNOWN** — UNKNOWN means *not established*. Nexum never
  converts missing evidence into PASS, ever.
- **Change** — something detected by comparing files/reports, or something a
  named person reported. The two are always labeled differently.
- **Dependency rule** — "if X changes, Y is worth re-checking." Rules only
  take effect after a named human on YOUR team approves them — Nexum never
  invents engineering judgments about your robot.
- **Revalidation plan** — the minimum re-checks owed after a change, each
  with the reason attached.

## What Nexum will never tell you

That your robot is "safe," that it "works," or that anything unmeasured is
fine. The strongest claim it makes is **VERIFIED FOR DEFINED CHECKS** — and
every claim carries who established it, how, and when.

## Beta

We're looking for FTC/VEX teams to try Nexum on their next **real** robot
change and tell us what it gets right or wrong. Two changes' worth of
feedback is all we ask. Contact: raghavender.kora@gmail.com
