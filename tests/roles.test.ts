import { describe, expect, it } from 'vitest';
import { hasRole, isRole, roles } from '../src/auth/roles.js';

describe('role permissions', () => {
  it('recognizes only the server-supported roles', () => {
    expect(roles).toEqual(['admin', 'staff', 'supplier', 'shipping', 'buyer']);
    expect(isRole('supplier')).toBe(true);
    expect(isRole('root')).toBe(false);
  });

  it('keeps staff out of admin-only payout and commission actions', () => {
    expect(hasRole('staff', ['admin'])).toBe(false);
    expect(hasRole('admin', ['admin'])).toBe(true);
  });

  it('allows staff to moderate products but not suppliers', () => {
    expect(hasRole('staff', ['admin', 'staff'])).toBe(true);
    expect(hasRole('staff', ['admin'])).toBe(false);
  });
});
