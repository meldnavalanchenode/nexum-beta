// engine invariant fuzz shard 1 — seeds 1..150000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(1, 150000)
