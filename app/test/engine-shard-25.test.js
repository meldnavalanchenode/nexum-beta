// engine invariant fuzz shard 25 — seeds 3600001..3750000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(3600001, 3750000)
