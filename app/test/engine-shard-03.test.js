// engine invariant fuzz shard 3 — seeds 300001..450000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(300001, 450000)
