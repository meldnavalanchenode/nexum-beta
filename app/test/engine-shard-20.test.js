// engine invariant fuzz shard 20 — seeds 2850001..3000000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(2850001, 3000000)
