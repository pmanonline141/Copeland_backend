export type TransactionalEmail = {
  to: string;
  subject: string;
  html: string;
};

export async function sendTransactionalEmail(email: TransactionalEmail) {
  const sendInDevelopment = process.env.RESEND_SEND_IN_DEVELOPMENT === 'true';
  if (process.env.NODE_ENV !== 'production' && !sendInDevelopment) {
    console.info('Transactional email:', { to: email.to, subject: email.subject });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL are required to send email');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: email.to, subject: email.subject, html: email.html }),
  });
  if (!response.ok) throw new Error(`Resend email delivery failed with status ${response.status}`);
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
