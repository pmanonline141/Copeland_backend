import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  determineOrdersToLink,
  type LinkableOrder,
  type LinkableUser,
} from '../src/services/orders.service.js';

describe('Guest Order Linking', () => {
  describe('Email normalization', () => {
    it('normalizes uppercase, lowercase, and mixed-case emails to lowercase', () => {
      expect(normalizeEmail('John.Doe@Example.COM')).toBe('john.doe@example.com');
      expect(normalizeEmail('BUYER@COMPANY.ORG')).toBe('buyer@company.org');
      expect(normalizeEmail('buyer@company.org')).toBe('buyer@company.org');
    });

    it('trims leading and trailing whitespace', () => {
      expect(normalizeEmail('  alice@example.com  ')).toBe('alice@example.com');
      expect(normalizeEmail('\t\nbob@test.com\r\n')).toBe('bob@test.com');
    });
  });

  describe('Linking guest orders on account registration and login', () => {
    it('links unattached guest orders to a newly registered user with verified email', () => {
      const newUser: LinkableUser = {
        id: 'user-buyer-1',
        email: 'alice@example.com',
        emailVerified: true,
      };

      const candidateOrders: LinkableOrder[] = [
        { id: 'order-1', buyerId: null, buyerEmail: 'alice@example.com' },
        { id: 'order-2', buyerId: null, buyerEmail: 'alice@example.com' },
      ];

      const { eligible, ineligibleReason } = determineOrdersToLink(newUser, candidateOrders);

      expect(ineligibleReason).toBeUndefined();
      expect(eligible).toHaveLength(2);
      expect(eligible.map((o) => o.id)).toEqual(['order-1', 'order-2']);
    });

    it('links guest orders on user login when orders were placed after account was created', () => {
      const existingUser: LinkableUser = {
        id: 'user-buyer-2',
        email: 'bob@example.com',
        emailVerified: true,
      };

      // Order placed as guest while logged out
      const candidateOrders: LinkableOrder[] = [
        { id: 'order-guest-new', buyerId: null, buyerEmail: 'bob@example.com' },
      ];

      const { eligible } = determineOrdersToLink(existingUser, candidateOrders);

      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe('order-guest-new');
    });

    it('matches emails with mixed-case and whitespace differences', () => {
      const user: LinkableUser = {
        id: 'user-buyer-3',
        email: '  Charlie.Brown@DOMAIN.com  ',
        emailVerified: true,
      };

      const candidateOrders: LinkableOrder[] = [
        { id: 'order-mixed-1', buyerId: null, buyerEmail: 'charlie.brown@domain.com' },
        { id: 'order-mixed-2', buyerId: null, buyerEmail: '  CHARLIE.BROWN@domain.COM ' },
      ];

      const { eligible } = determineOrdersToLink(user, candidateOrders);

      expect(eligible).toHaveLength(2);
      expect(eligible.map((o) => o.id)).toEqual(['order-mixed-1', 'order-mixed-2']);
    });
  });

  describe('Security and misattribution guards', () => {
    it('blocks linking if the user email is unverified (guard against account hijacking)', () => {
      const unverifiedAttacker: LinkableUser = {
        id: 'attacker-1',
        email: 'victim@example.com',
        emailVerified: false,
      };

      const victimOrders: LinkableOrder[] = [
        { id: 'victim-order-1', buyerId: null, buyerEmail: 'victim@example.com' },
      ];

      const { eligible, ineligibleReason } = determineOrdersToLink(unverifiedAttacker, victimOrders);

      expect(ineligibleReason).toBe('EMAIL_NOT_VERIFIED');
      expect(eligible).toHaveLength(0);
    });

    it('does not link orders belonging to a different email address', () => {
      const user: LinkableUser = {
        id: 'user-buyer-4',
        email: 'dave@example.com',
        emailVerified: true,
      };

      const candidateOrders: LinkableOrder[] = [
        { id: 'order-dave', buyerId: null, buyerEmail: 'dave@example.com' },
        { id: 'order-other-1', buyerId: null, buyerEmail: 'someone.else@example.com' },
        { id: 'order-other-2', buyerId: null, buyerEmail: 'dave@otherdomain.com' },
      ];

      const { eligible } = determineOrdersToLink(user, candidateOrders);

      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe('order-dave');
    });

    it('never links orders that are already attached to an existing account', () => {
      const user: LinkableUser = {
        id: 'user-buyer-5',
        email: 'shared@example.com',
        emailVerified: true,
      };

      const candidateOrders: LinkableOrder[] = [
        // Already attached to another account
        { id: 'order-already-claimed', buyerId: 'another-user-999', buyerEmail: 'shared@example.com' },
        // Unattached guest order
        { id: 'order-unclaimed', buyerId: null, buyerEmail: 'shared@example.com' },
      ];

      const { eligible } = determineOrdersToLink(user, candidateOrders);

      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe('order-unclaimed');
    });
  });

  describe('Idempotency of repeated linking', () => {
    it('is completely idempotent when re-run multiple times', () => {
      const user: LinkableUser = {
        id: 'user-buyer-6',
        email: 'eva@example.com',
        emailVerified: true,
      };

      // State before first run: 2 guest orders
      const ordersInDb: LinkableOrder[] = [
        { id: 'order-eva-1', buyerId: null, buyerEmail: 'eva@example.com' },
        { id: 'order-eva-2', buyerId: null, buyerEmail: 'eva@example.com' },
      ];

      // 1st Run
      const run1 = determineOrdersToLink(user, ordersInDb);
      expect(run1.eligible).toHaveLength(2);

      // Simulate DB update after run 1: orders now attached to user
      for (const order of ordersInDb) {
        if (run1.eligible.some((e) => e.id === order.id)) {
          order.buyerId = user.id;
        }
      }

      // 2nd Run on updated state
      const run2 = determineOrdersToLink(user, ordersInDb);
      expect(run2.eligible).toHaveLength(0);

      // 3rd Run
      const run3 = determineOrdersToLink(user, ordersInDb);
      expect(run3.eligible).toHaveLength(0);

      // Final verification: orders stay attached to user-buyer-6
      expect(ordersInDb[0].buyerId).toBe(user.id);
      expect(ordersInDb[1].buyerId).toBe(user.id);
    });
  });
});
