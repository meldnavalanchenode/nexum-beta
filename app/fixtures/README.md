# Controlled test mode — the demo fixtures

Every fixture here is a **real payload** in the exact shape `POST /status`,
`POST /state`, and the CLI consume — no special demo format exists, so the
application processes these precisely as it would real observations. The
"camera" is a HuskyLens (a real FTC I2C vision sensor), so nothing here
pretends to hardware capabilities PHYSYNC doesn't have.

| Fixture | Scenario | What the engine should conclude |
|---|---|---|
| `baseline_robot.json` | The hand-verified robot (config + code + robot report + stimulus) | Saves as V1; status against itself = VERIFIED FOR DEFINED CHECKS |
| `camera_changed.json` | Camera moved to another I2C bus | Invalidates `calibration:C7` → demands the 3 perception tests, **never** the grasp tests |
| `firmware_changed.json` | Hub firmware 1.8.2 → 1.9.0 | Invalidates hub census + every measured motor/servo response → demands the stimulus re-run |
| `gripper_changed.json` | Gripper servo port 1 → 4 | Demands the 3 grasp tests + the gripper's stimulus evidence, **never** the perception tests |
| `multiple_changes.json` | Camera + gripper + firmware at once | The UNION plan, deduplicated: one stimulus run, one calibration, all 6 tests — not 10 separate executions |
| `unknown_state.json` | Camera answers all zeros | `sensor-response-lost` change; nothing UNKNOWN ever converts to PASS |
| `camera_reported_demo.json` | **SIMULATED** — a person reports the camera mount was re-aimed (no file changed) | Change records as HUMAN-REPORTED, never detected; the `camera-pose` pack stays inert until a named approval; then calibration + localization are owed until fresh post-report results land |

`graph.json` and `tests.json` are the demo dependency edges (user-approved,
`approvedBy: demo-fixture`) and test definitions (authored thresholds).
Copy them into a workspace's `.physync/` to arm the demo:

```bash
mkdir -p demo/.physync && cd demo
cp ../app/fixtures/{graph,tests}.json .physync/
# stage the baseline, save V1, then feed any changed fixture to `physync status`
```

The automated version of this entire table lives in `test/workflow.test.js`,
which also runs the spec's ten-step workflow end to end. These fixtures are
the Diamond demo: swap one file, watch the engine name what died and the
minimum that resurrects it.

`camera_reported_demo.json` is different from the rest and says so in its own
contents: it is **marked simulated**, every human name in it is "Demo …", and
its arc (`test/reported-workflow.test.js`) exercises the human-reported path,
where nothing was detected because nothing on disk changed. Results recorded
with `--simulated` never satisfy a requirement and never fold into a verified
state — demo evidence cannot verify a real robot, in this fixture or anywhere.
