import { describe, expect, it } from 'vitest';
import { PayoutService } from '../src/services/payouts.service.js';

describe('payout review window', () => {
  it('makes an item eligible three days after delivery', () => {
    const deliveredAt = new Date('2026-10-01T12:30:00.000Z');
    expect(PayoutService.payoutEligibleAt(deliveredAt).toISOString())
      .toBe('2026-10-04T12:30:00.000Z');
  });
});
