// engine invariant fuzz shard 10 — seeds 1350001..1500000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(1350001, 1500000)
