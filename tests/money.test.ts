import { afterEach, describe, expect, it } from 'vitest';
import { calculateCommissionKobo, getCommissionRateBps } from '../src/services/money.js';

const originalDefaultRate = process.env.DEFAULT_COMMISSION_BPS;

afterEach(() => {
  if (originalDefaultRate === undefined) {
    delete process.env.DEFAULT_COMMISSION_BPS;
  } else {
    process.env.DEFAULT_COMMISSION_BPS = originalDefaultRate;
  }
});

describe('money calculations', () => {
  it('uses the configured default commission in integer basis points', () => {
    process.env.DEFAULT_COMMISSION_BPS = '725';
    expect(getCommissionRateBps()).toBe(725);
    expect(calculateCommissionKobo(12_345, getCommissionRateBps())).toBe(895);
  });

  it('uses a supplier override instead of the default', () => {
    process.env.DEFAULT_COMMISSION_BPS = '1000';
    expect(getCommissionRateBps(1250)).toBe(1250);
    expect(calculateCommissionKobo(10_000, getCommissionRateBps(1250))).toBe(1250);
  });

  it('rejects non-integer or out-of-range commission configuration', () => {
    process.env.DEFAULT_COMMISSION_BPS = '10.5';
    expect(() => getCommissionRateBps()).toThrow('DEFAULT_COMMISSION_BPS');
    process.env.DEFAULT_COMMISSION_BPS = '1000';
    expect(() => getCommissionRateBps(10_001)).toThrow('Supplier commission rate');
    expect(() => calculateCommissionKobo(1.5, 1000)).toThrow('Amount');
  });
});
