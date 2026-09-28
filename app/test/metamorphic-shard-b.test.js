// Metamorphic shard b — seeds 100,001..200,000 of the causality corpus.
// The scenarios live in helpers/metamorphic-core.js; see metamorphic-gate.test.js.
import { runMetamorphicShard } from './helpers/metamorphic-core.js'
runMetamorphicShard(100001, 200000)
