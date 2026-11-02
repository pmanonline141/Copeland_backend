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

export async function sendTransactionalEmail(email: TransactionalEmail): Promise<{ delivery: 'sent' | 'skipped' }> {
  const sendInDevelopment = process.env.RESEND_SEND_IN_DEVELOPMENT === 'true';
  if (process.env.NODE_ENV !== 'production' && !sendInDevelopment) {
    logger.info({
      provider: 'resend',
      emailType: email.emailType ?? 'transactional',
      delivery: 'skipped',
      reason: 'development_sending_disabled',
    }, 'Transactional email skipped');
    return { delivery: 'skipped' };
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
  return { delivery: 'sent' };
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

/**
 * Normalizes a Nigerian telephone number to international format (234...)
 * E.g. "07061234567" -> "2347061234567", "+2348012345678" -> "2348012345678"
 */
export function formatNigerianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) {
    return `234${digits.slice(1)}`;
  }
  if (digits.startsWith('234') && digits.length === 13) {
    return digits;
  }
  return digits;
}

/**
 * Sends a WhatsApp notification.
 * No-op returning "skipped" unless WHATSAPP_ENABLED=true.
 *
 * NOTE: For business-initiated messages via the Meta WhatsApp Cloud API,
 * Meta requires pre-approved message templates (e.g. for quotes, order updates).
 * Free-form text messages can only be sent within an active 24-hour customer care window.
 */
export async function sendWhatsAppMessage(phone?: string | null, text?: string): Promise<'sent' | 'failed' | 'skipped'> {
  if (process.env.WHATSAPP_ENABLED !== 'true' || !phone || !text) {
    return 'skipped';
  }

  /*
   * Meta WhatsApp Cloud API implementation (no extra dependencies required):
   *
   * const token = process.env.WHATSAPP_API_TOKEN;
   * const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
   * if (!token || !phoneNumberId) return 'skipped';
   *
   * try {
   *   const recipient = formatNigerianPhone(phone);
   *   const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
   *     method: 'POST',
   *     headers: {
   *       'Authorization': `Bearer ${token}`,
   *       'Content-Type': 'application/json',
   *     },
   *     body: JSON.stringify({
   *       messaging_product: 'whatsapp',
   *       recipient_type: 'individual',
   *       to: recipient,
   *       type: 'text',
   *       text: { preview_url: false, body: text },
   *     }),
   *   });
   *   if (!response.ok) {
   *     logger.warn({ status: response.status, phone: recipient }, 'WhatsApp Cloud API request failed');
   *     return 'failed';
   *   }
   *   return 'sent';
   * } catch (error) {
   *   logger.warn({ ...errorLogFields(error) }, 'WhatsApp Cloud API request exception');
   *   return 'failed';
   * }
   */

  return 'skipped';
}
