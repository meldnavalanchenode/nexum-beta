// engine invariant fuzz shard 2 — seeds 150001..300000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(150001, 300000)
