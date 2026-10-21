# Nexum

**When your robot changes, Nexum tells you which of your previous testing no
longer counts — and the minimum you must re-verify before trusting the robot
again.**

FTC robots today (config XML + Java TeamCode). Runs on your laptop, offline.
It reads files; **nothing ever runs on your robot.**

---

## The beta, in one paragraph

You set Nexum up once (~10 min). Then, the next time your robot really
changes, you do four things that take about four minutes total: write down
what *you* would re-check, run Nexum, do the checks, and tell Nexum what
actually happened. We learn whether Nexum's answer was better, worse, or the
same as yours. **Two changes and we leave you alone.** Honest "it was useless"
is the most valuable result you can give us — that is the point of the test.

---

**Beta window:** Nexum runs for **30 days** from your first `init`, then stops
and asks you to get in touch. Every command prints the days remaining (except
`--json` runs, which stay machine-clean). Your records
are plain JSON in `.physync/` and stay readable either way — the deadline stops
the tool, not your data. The clock is stored in `.physync/trial.json` and in
`~/.nexum/trial.json`; the latter is the only file Nexum writes outside your
project, holds one timestamp and nothing else, and exists so the window is one
30-day run per download rather than one per folder.

## 1 · Get it and prove it runs (60 seconds)

Install [Node.js](https://nodejs.org) **20 or newer** (`node --version` to
check), then:

```bash
git clone https://github.com/meldnavalanchenode/nexum-beta.git
cd nexum-beta
node app/bin/physync.js check --config app/samples/config.xml --code app/samples/TeamCode
```

You should see a deliberately broken sample robot **FAIL**, naming each
mismatch (including a did-you-mean for a typo'd device). If you see that
banner, Nexum works on your machine. Nothing was installed; no network was
used.

## 2 · Set up for YOUR robot (one time, ~5 min)

Work in a folder that has your **config XML** (from the Robot Controller:
`/sdcard/FIRST/*.xml`) and your **TeamCode folder**.

```bash
node app/bin/physync.js init --config yourconfig.xml --code YourTeamCode --by yourName
```

`init` defines three starter checks and loads candidate dependency rules —
then stops and prints the one decision **it will not make for you**:

> A dependency rule says *"if X changes, re-check Y."* Nexum does not know
> whether that is true of **your** robot, so every rule stays inert until
> someone on your team approves it by name.

Approve the ones you agree with (it prints the exact commands):

```bash
node app/bin/physync.js graph --approve camera-pose:01 --by yourName
```

Rules you don't approve stay proposed, and Nexum will say **UNKNOWN** rather
than guess. That's the design, not a gap.

*Optional but better:* record any test results you already trust, so your
baseline has real evidence in it —
`node app/bin/physync.js result --test localization --value 0.95 --by yourName`

## 3 · Freeze today's robot as V1

Do this while the robot works:

```bash
node app/bin/physync.js state --config yourconfig.xml --code YourTeamCode
```

That's your **verified state** — permanent, tamper-evident, never edited.

## 4 · The loop, next time the robot changes

**BEFORE you look at Nexum** — this order matters, it's the whole experiment:

```bash
node app/bin/physync.js predict --checks "drive-straight, localization" --by yourName
```

Then, after the change (part swap, port move, re-flash, code refactor):

```bash
node app/bin/physync.js status
```

No flags needed — it remembers your paths. You'll get: what changed, which
previous evidence it put in question, and the minimum re-checks owed, each
with the reason and the command to record it.

A physical change no file can see (re-aimed camera, swapped wheels)? Tell it,
with your name on it:

```bash
node app/bin/physync.js change --component camera-position --note "re-aimed the mount" --by yourName
```

Do the checks, record each one, then close the loop:

```bash
node app/bin/physync.js result --test localization --pass --by yourName
node app/bin/physync.js debrief --checked "localization, camera-pose" --by yourName
node app/bin/physync.js state --config yourconfig.xml --code YourTeamCode   # ← V2
```

Use `--pass`, `--fail`, or `--unknown` — your judgment, recorded with your
name. You can log a number instead (`--value 0.96`), but a number only
becomes PASS or FAIL once *someone on your team* has set the bar it must
clear. Until then Nexum records the number and says **UNKNOWN**, because a
measurement with no threshold hasn't been judged yet — by anyone.

To set that bar on any check — including the three `init` created:

```bash
node app/bin/physync.js tests --threshold --id localization --min 0.9 --by yourName
```

Changing a bar later is allowed and prints exactly what it changed, but
**results you already recorded keep the verdict they were given.** A threshold
is never applied retroactively, so history can't be re-graded by moving a
goalpost.

`debrief` prints the comparison: what you both named, what Nexum added, what
you did that it never mentioned. It does **not** grade itself — that judgment
is a human's.

---

## What each evidence row means after a change

Historical results **never change** — a PASS from last week is a PASS forever,
recorded against the state it belonged to. What changes is **applicability**:

- ✓ **APPLICABLE** — no known dependency connects it to any change
- ! **REVALIDATE** — a change reached it through an approved dependency
- ? **UNKNOWN** — a *proposed* rule links it, but nobody has ruled on it yet
- ↻ **RE-DERIVED** — this run's inputs re-established it

## What Nexum will never tell you

That your robot is "safe," that it "works," or that anything unmeasured is
fine. The strongest claim it makes is **VERIFIED FOR DEFINED CHECKS**. Missing
evidence stays **UNKNOWN** — it never becomes PASS.

## Privacy — what leaves your machine

**Nothing.** The whole loop above is offline; there is no account, no
telemetry, no upload. Everything Nexum records lives in a `.physync/` folder in
your project; the only file outside it is the beta clock's single timestamp at
`~/.nexum/trial.json`.
(One optional command, `explain`, calls an AI API — it only runs if *you* set
an API key, and it never affects any verdict. Don't use it for the beta.)

If you send us anything, send the `.physync` folder: it holds states, results,
and rules — **not your source code**. Look inside first; it's plain JSON.

## If something goes wrong

- **It crashed or said something confusing** — send us the command you ran and
  everything it printed. That's a finding, not your fault.
- **Start over** — delete the `.physync` folder. Your robot is never touched at
  all. `~/.nexum/trial.json` stays, so starting over is a clean slate rather
  than a new 30 days.
- **Nothing is destructive** — Nexum writes inside `.physync/` and the one
  timestamp at `~/.nexum/trial.json`, never edits your config or code, and
  never overwrites a saved state.

## Known limitations (so you're not surprised)

- Java/Blocks TeamCode; the Blocks convention is less verified than Java.
- Nexum has **never run on a real Control Hub** — it reads files you give it.
- Rules are yours to approve; out of the box it knows very little about your
  robot on purpose.
- VEX support exists but is not part of this beta.

Questions or anything broken: ashrith.kora@gmail.com
