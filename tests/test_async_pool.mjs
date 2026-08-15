import assert from "node:assert/strict";
import { runConcurrent } from "../static/async-pool.js";

let active = 0;
let maximumActive = 0;
const completed = [];
await runConcurrent([1, 2, 3, 4, 5, 6], 3, async (value) => {
  active++;
  maximumActive = Math.max(maximumActive, active);
  await new Promise((resolve) => setTimeout(resolve, 5));
  completed.push(value);
  active--;
});

assert.equal(maximumActive, 3);
assert.deepEqual(completed.sort((left, right) => left - right), [1, 2, 3, 4, 5, 6]);
console.log("Concurrent analysis worker tests passed.");
