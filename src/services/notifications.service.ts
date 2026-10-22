import { errorLogFields, logger } from '../logger.js';

export type TransactionalEmail = {
  to: string;
  subject: string;
  html: string;
  emailType?: 'signup_verification' | 'welcome' | 'password_reset' | 'password_reset_confirmation' | 'transactional';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getProviderMessage(payload: unknown) {
  if (!isRecord(payload)) return undefined;
  const message = payload.message;
  return typeof message === 'string' ? message.slice(0, 300) : undefined;
}

export async function sendTransactionalEmail(email: TransactionalEmail) {
  const sendInDevelopment = process.env.RESEND_SEND_IN_DEVELOPMENT === 'true';
  if (process.env.NODE_ENV !== 'production' && !sendInDevelopment) {
    logger.info({
      provider: 'resend',
      emailType: email.emailType ?? 'transactional',
      delivery: 'skipped',
      reason: 'development_sending_disabled',
    }, 'Transactional email skipped');
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL are required to send email');

  const emailType = email.emailType ?? 'transactional';
  logger.info({ provider: 'resend', emailType }, 'Transactional email delivery started');

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: email.to, subject: email.subject, html: email.html }),
    });
  } catch (error) {
    logger.error({ provider: 'resend', emailType, ...errorLogFields(error) }, 'Transactional email request failed');
    throw error;
  }

  const responseText = await response.text();
  let providerResponse: unknown;
  try {
    providerResponse = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    providerResponse = undefined;
  }

  if (!response.ok) {
    const providerMessage = getProviderMessage(providerResponse);
    logger.error({
      provider: 'resend',
      emailType,
      statusCode: response.status,
      ...(providerMessage ? { providerMessage } : {}),
    }, 'Transactional email delivery failed');
    throw new Error(`Resend email delivery failed with status ${response.status}${providerMessage ? `: ${providerMessage}` : ''}`);
  }

  const emailId = isRecord(providerResponse) && typeof providerResponse.id === 'string'
    ? providerResponse.id
    : undefined;
  logger.info({
    provider: 'resend',
    emailType,
    statusCode: response.status,
    ...(emailId ? { emailId } : {}),
    providerAccepted: true,
  }, 'Transactional email accepted by provider');
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}
