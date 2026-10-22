import { describe, expect, it } from 'vitest';
import {
  orderConfirmationEmail,
  partnerReviewEmail,
  passwordResetEmail,
  verificationEmail,
} from '../src/services/email-templates.js';

describe('transactional email templates', () => {
  it('escapes names and verification URLs in signup email', () => {
    const email = verificationEmail('buyer@example.com', '<Buyer>', 'https://example.com/verify?token=a&next=b');

    expect(email.to).toBe('buyer@example.com');
    expect(email.subject).toContain('Verify');
    expect(email.html).toContain('&lt;Buyer&gt;');
    expect(email.html).toContain('token=a&amp;next=b');
    expect(email.html).not.toContain('<Buyer>');
  });

  it('uses secure reset links without exposing passwords', () => {
    const email = passwordResetEmail('buyer@example.com', 'Buyer', 'https://example.com/reset?token=secret');

    expect(email.html).toContain('Reset password');
    expect(email.html).toContain('token=secret');
    expect(email.html.toLowerCase()).not.toContain('password123');
  });

  it('provides role-appropriate partner approval next steps', () => {
    const email = partnerReviewEmail('supplier@example.com', 'Supplier', 'approved', 'Reviewed', 'https://example.com/login');

    expect(email.subject).toContain('approved');
    expect(email.html).toContain('approved partner onboarding');
    expect(email.html).toContain('https://example.com/login');
  });

  it('escapes order identifiers and product names', () => {
    const email = orderConfirmationEmail('buyer@example.com', '<order>', ['<shirt>']);

    expect(email.html).toContain('&lt;order&gt;');
    expect(email.html).toContain('&lt;shirt&gt;');
    expect(email.html).not.toContain('<shirt>');
  });
});
