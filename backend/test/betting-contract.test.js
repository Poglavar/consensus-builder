// Deadline settlement and fixed-share quotes use the same exact arithmetic in both betting books.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Contract = require('../../frontend/js/bets/betting-contract.js');
const Lmsr = require('../../frontend/js/bets/lmsr.js');

const market = (overrides = {}) => ({ closesAt: 100, graceSeconds: 0, resolved: false, ...overrides });

describe('dated agreement-market contract', () => {
  it('settles execution at or before cutoff YES and execution after cutoff NO', () => {
    expect(Contract.executionOutcome({ chainStatus: 'executed', executedAt: 100 }, market(), 101)).toBe('yes');
    expect(Contract.executionOutcome({ chainStatus: 'executed', executedAt: 99 }, market(), 101)).toBe('yes');
    expect(Contract.executionOutcome({ chainStatus: 'executed', executedAt: 101 }, market(), 101)).toBe('no');
  });

  it.each([
    [{ chainStatus: 'pending' }, 'Agreement status is unknown'],
    [{ chainStatus: 'executed' }, 'executedAt must be unix seconds'],
    [{ chainStatus: 'executed', executedAt: 0 }, 'Agreement execution time is invalid'],
    [{ chainStatus: 'executed', executedAt: 102 }, 'Agreement execution time is invalid'],
  ])('rejects unknown status or invalid execution timestamp', (source, message) => {
    expect(() => Contract.executionOutcome(source, market(), 101)).toThrow(message);
  });

  it('cannot settle an active agreement before cutoff, then settles NO at the grace cutoff', () => {
    expect(Contract.executionOutcome({ chainStatus: 'active' }, market({ graceSeconds: 5 }), 104)).toBeNull();
    expect(Contract.executionOutcome({ chainStatus: 'active' }, market({ graceSeconds: 5 }), 105)).toBe('no');
    expect(Contract.canTrade({ chainStatus: 'active' }, market(), 99)).toBe(true);
    expect(Contract.canTrade({ chainStatus: 'active' }, market(), 100)).toBe(false);
  });

  it('maps cancellation to VOID and expiry to NO; floors per-side void payout', () => {
    expect(Contract.executionOutcome({ chainStatus: 'cancelled' }, market(), 99)).toBe('void');
    expect(Contract.executionOutcome({ chainStatus: 'expired' }, market(), 99)).toBe('no');
    expect(Contract.payout('yes', 1n, 'void')).toBe(0n);
    expect(Contract.payout('no', 3n, 'void')).toBe(1n);
    expect(Contract.payout('yes', 7n, 'yes')).toBe(7n);
    expect(Contract.payout('no', 7n, 'yes')).toBe(0n);
  });

  it('parses positive six-decimal amounts, malformed text and the safe atomic maximum', () => {
    expect(Contract.parseAmount(' 1.234567 ')).toBe(1234567n);
    expect(Contract.atomic(Lmsr.MAX_QUANTITY)).toBe(Lmsr.MAX_QUANTITY);
    for (const value of ['0', '-1', '1e3', '1.1234567', '', '1.']) expect(() => Contract.parseAmount(value)).toThrow();
    expect(() => Contract.atomic(Lmsr.MAX_QUANTITY + 1n)).toThrow();
    expect(() => Contract.atomic('01x')).toThrow();
  });

  it('quotes a buy and charges the documented one-unit guard on both buy and sell', () => {
    const initial = { model: 'lmsr', b: 1000000n, qYes: 0n, qNo: 0n };
    const buy = Contract.quote(initial, 'yes', 10000n, 'buy');
    expect(buy.action).toBe('buy');
    expect(buy.shares).toBeGreaterThan(0n);
    expect(buy.amount).toBeLessThanOrEqual(10000n);
    const qYes = buy.shares;
    const sell = Contract.quote({ ...initial, qYes }, 'yes', qYes, 'sell');
    const before = Lmsr.cost(initial.b, 0n, 0n);
    const after = Lmsr.cost(initial.b, qYes, 0n);
    expect(buy.amount).toBe(after + 1n - before);
    expect(sell.amount).toBe(after - before - 1n);
    expect(buy.amount - sell.amount).toBeGreaterThanOrEqual(2n);
  });
});
