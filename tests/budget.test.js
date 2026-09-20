import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget } from '../budget.js';

test('a dollar buys exactly fifty two-cent reservations', () => {
  const budget = createBudget(1);
  for (let i = 0; i < 50; i++) budget.reserve(.02);
  assert.deepEqual(budget.status(), { spentUsd: 1, ceilingUsd: 1, remainingUsd: 0 });
  assert.throws(() => budget.reserve(.02), /Spend guard/);
});
test('concurrent callers reserve before yielding', async () => {
  const budget = createBudget(.02);
  const results = await Promise.allSettled([1, 2].map(async () => { budget.reserve(.02); await Promise.resolve(); }));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('a provably unsent payment refunds only once', () => {
  const budget = createBudget(1), refund = budget.reserve(.25);
  refund(); refund(); assert.equal(budget.status().spentUsd, 0);
});
test('invalid amounts cannot increase the budget', () => {
  const budget = createBudget(1);
  for (const amount of [-1, NaN, Infinity]) assert.throws(() => budget.reserve(amount));
  assert.throws(() => createBudget(Infinity));
});
