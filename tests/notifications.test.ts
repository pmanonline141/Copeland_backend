import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
  errorLogFields: (error: unknown) => ({
    errorName: error instanceof Error ? error.name : 'UnknownError',
  }),
}));

import { logger } from '../src/logger.js';
import { sendTransactionalEmail } from '../src/services/notifications.service.js';

describe('transactional email delivery', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RESEND_SEND_IN_DEVELOPMENT', 'true');
    vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
    vi.stubEnv('RESEND_FROM_EMAIL', 'Copeland <onboarding@resend.dev>');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('logs a successful provider response without logging recipient or email content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 'email_123' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionalEmail({
      to: 'buyer@example.com',
      subject: 'Verify your email',
      html: '<a href="https://example.com/verify?token=secret">Verify</a>',
      emailType: 'signup_verification',
    });

    expect(logger.info).toHaveBeenCalledWith({
      provider: 'resend',
      emailType: 'signup_verification',
    }, 'Transactional email delivery started');
    expect(logger.info).toHaveBeenCalledWith({
      provider: 'resend',
      emailType: 'signup_verification',
      providerAccepted: true,
      statusCode: 200,
      emailId: 'email_123',
    }, 'Transactional email accepted by provider');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('buyer@example.com');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('secret');
  });

  it('logs provider errors and rejects the delivery instead of silently succeeding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'Invalid API key' }),
      { status: 401 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTransactionalEmail({
      to: 'buyer@example.com',
      subject: 'Verify your email',
      html: '<p>Verify</p>',
    })).rejects.toThrow('Resend email delivery failed with status 401: Invalid API key');

    expect(logger.error).toHaveBeenCalledWith({
      provider: 'resend',
      emailType: 'transactional',
      statusCode: 401,
      providerMessage: 'Invalid API key',
    }, 'Transactional email delivery failed');
  });

  it('reports when local email delivery is disabled without calling Resend', async () => {
    vi.stubEnv('RESEND_SEND_IN_DEVELOPMENT', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionalEmail({
      to: 'buyer@example.com',
      subject: 'Verify your email',
      html: '<p>Verify</p>',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({
      provider: 'resend',
      emailType: 'transactional',
      delivery: 'skipped',
      reason: 'development_sending_disabled',
    }, 'Transactional email skipped');
  });
});
