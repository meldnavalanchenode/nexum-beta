// Metamorphic gate suite — causality, not just sensitivity. 200,000 seeded
// scenarios across the shard files (this one runs seeds 1..100,000;
// metamorphic-shard-b.test.js continues to 200,000): approve a randomized
// robot, observe it unchanged (must be clean), then apply exactly ONE
// semantic change and assert the gate reports exactly THAT change — right
// check id, right address/name in the message, right verdict — and nothing
// else. A gate that fires the wrong finding for a cause is as broken as one
// that misses it: the human in the pit acts on the message, not the exit
// code. The scenarios live once, in helpers/metamorphic-core.js.

import { runMetamorphicShard } from './helpers/metamorphic-core.js'

runMetamorphicShard(1, 100000)
