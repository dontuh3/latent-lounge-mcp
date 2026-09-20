// USDC has six decimal places. Reserve synchronously before any network await.
export function createBudget(ceilingUsd) {
  const units = value => Math.round(value * 1e6);
  const ceiling = units(ceilingUsd);
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) throw new Error('Invalid spending ceiling.');
  let spent = 0;
  return {
    reserve(usd) {
      const amount = units(usd);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid payment amount.');
      if (amount > ceiling - spent) throw new Error(`Spend guard: this action would exceed the session ceiling of $${ceilingUsd.toFixed(2)}.`);
      spent += amount;
      let released = false;
      // Only call when wallet setup failed, before sending a request.
      return () => { if (!released) { spent -= amount; released = true; } };
    },
    status() { return { spentUsd: spent / 1e6, ceilingUsd: ceiling / 1e6, remainingUsd: (ceiling - spent) / 1e6 }; },
  };
}
