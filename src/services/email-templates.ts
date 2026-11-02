import type { TransactionalEmail } from './notifications.service.js';
import { escapeHtml } from './notifications.service.js';

function layout(title: string, preview: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4f5f7;font-family:Arial,sans-serif;color:#202124"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preview)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;background:#f4f5f7"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:8px"><tr><td style="padding:32px"><p style="margin:0 0 24px;font-size:20px;font-weight:bold">Copeland</p><h1 style="font-size:24px">${escapeHtml(title)}</h1>${content}<p style="margin-top:32px;color:#6b7280;font-size:13px">Copeland Clothiers Limited · copeland.africa</p></td></tr></table></td></tr></table></body></html>`;
}

function button(label: string, url: string) {
  return `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(label)}</a></p>`;
}

function message(to: string, subject: string, title: string, preview: string, content: string): TransactionalEmail {
  return { to, subject, html: layout(title, preview, content) };
}

export function verificationEmail(to: string, name: string, url: string) {
  const title = 'Verify your email address';
  return message(to, title, title, 'Confirm your email to finish setting up your Copeland account.',
    `<p>Hello ${escapeHtml(name)},</p><p>Confirm your email address to secure your account and continue.</p>${button('Verify email address', url)}<p>If you did not create a Copeland account, you can ignore this email.</p>`);
}

export function welcomeEmail(to: string, name: string, signInUrl: string) {
  const title = 'Welcome to Copeland';
  return message(to, title, title, 'Your Copeland account is ready.',
    `<p>Hello ${escapeHtml(name)},</p><p>Welcome to copeland.africa, a platform connecting buyers with clothing suppliers and shipping partners.</p><p>Verify your email address before signing in.</p>${button('Go to Copeland', signInUrl)}<p>For your security, Copeland will never ask you to send your password by email.</p>`);
}

export function passwordResetEmail(to: string, name: string, url: string) {
  const title = 'Reset your Copeland password';
  return message(to, title, title, 'Use the secure link to choose a new password.',
    `<p>Hello ${escapeHtml(name)},</p><p>We received a request to reset the password for your account. This link expires according to the reset request window.</p>${button('Reset password', url)}<p>If you did not request this, ignore this message. Your password will not change.</p>`);
}

export function passwordResetConfirmationEmail(to: string, name: string) {
  const title = 'Your password was changed';
  return message(to, title, title, 'Your Copeland account password has been updated.',
    `<p>Hello ${escapeHtml(name)},</p><p>Your Copeland password was successfully changed. If you did not make this change, reset your password immediately and contact Copeland support.</p>`);
}

export function partnerApplicationReceivedEmail(to: string, name: string) {
  const title = 'Partner application received';
  return message(to, `Copeland partner application received`, title, 'We received your partner application.',
    `<p>Hello ${escapeHtml(name)},</p><p>We received your partner application and will review it. We will email you when its status changes.</p>`);
}

export function partnerReviewEmail(
  to: string,
  name: string,
  status: 'approved' | 'rejected' | 'suspended',
  note: string | undefined,
  signInUrl: string,
) {
  const titles = {
    approved: 'Your Copeland partner application is approved',
    rejected: 'Your Copeland partner application was not approved',
    suspended: 'Your Copeland partner account has been suspended',
  };
  const title = titles[status];
  const details = note ? `<p>${escapeHtml(note)}</p>` : '';
  const nextStep = status === 'approved'
    ? `<p>Your account role has been enabled. Sign in to continue; supplier and shipping features require approved partner onboarding.</p>${button('Sign in to Copeland', signInUrl)}`
    : '';
  return message(to, title, title, title, `<p>Hello ${escapeHtml(name)},</p>${details}${nextStep}`);
}

export function productModerationEmail(to: string, productName: string, subject: string, reason?: string) {
  const title = subject;
  const details = reason ? `<p>${escapeHtml(reason)}</p>` : '';
  return message(to, subject, title, `There is an update about ${productName}.`,
    `<p>Your product <strong>${escapeHtml(productName)}</strong> has a moderation update.</p>${details}`);
}

export function orderConfirmationEmail(to: string, orderNumber: string, itemNames: string[]) {
  const title = `Order ${orderNumber} confirmed`;
  const items = itemNames.map((name) => `<li>${escapeHtml(name)}</li>`).join('');
  return message(to, `Copeland order ${orderNumber} confirmed`, title, 'Your payment has been confirmed.',
    `<p>Your payment has been confirmed for order <strong>${escapeHtml(orderNumber)}</strong>.</p>${items ? `<ul>${items}</ul>` : ''}`);
}

export function orderStatusEmail(to: string, orderNumber: string, status: 'shipped' | 'delivered') {
  const title = `Order ${orderNumber} ${status}`;
  return message(to, `Copeland order ${orderNumber} ${status}`, title, `Your order has been ${status}.`,
    `<p>Order <strong>${escapeHtml(orderNumber)}</strong> has been ${status}.</p>`);
}

export function payoutSentEmail(to: string, amountKobo: number, reference: string) {
  const title = 'Copeland payout sent';
  return message(to, title, title, 'A payout has been recorded for your account.',
    `<p>A payout of ${amountKobo.toLocaleString('en-NG')} kobo was sent.</p><p>Reference: <strong>${escapeHtml(reference)}</strong></p>`);
}

export function rfqQuoteEmail(
  to: string,
  requesterName: string,
  rfqId: string,
  quoteAmountKobo: number,
  quoteMessage: string,
  items: Array<{ name: string; quantity: number; size?: string; colour?: string }>,
) {
  const shortId = rfqId.slice(0, 8).toUpperCase();
  const subject = `Your Copeland quote #${shortId}`;
  const title = `Your Copeland quote #${shortId}`;

  const naira = quoteAmountKobo / 100;
  const formattedTotal = '₦' + naira.toLocaleString('en-NG', {
    minimumFractionDigits: quoteAmountKobo % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });

  const rows = items.map((item) => `
    <tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:10px 8px;font-weight:500">${escapeHtml(item.name)}</td>
      <td style="padding:10px 8px;text-align:center">${escapeHtml(String(item.quantity))}</td>
      <td style="padding:10px 8px">${escapeHtml(item.size || '—')}</td>
      <td style="padding:10px 8px">${escapeHtml(item.colour || '—')}</td>
    </tr>
  `).join('');

  const itemsTable = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;text-align:left">
          <th style="padding:10px 8px;font-weight:600">Product</th>
          <th style="padding:10px 8px;font-weight:600;text-align:center">Quantity</th>
          <th style="padding:10px 8px;font-weight:600">Size</th>
          <th style="padding:10px 8px;font-weight:600">Colour</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;

  const content = `
    <p>Hello ${escapeHtml(requesterName)},</p>
    <p>We have reviewed your request for quote (ref: <strong>#${shortId}</strong>). Here is our official quotation:</p>
    <div style="margin:24px 0;padding:20px;background:#fdfcf9;border:1px solid #e6d2a0;border-radius:6px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:bold;text-transform:uppercase;color:#7a5a2c;letter-spacing:0.05em">Quote Amount</p>
      <p style="margin:0;font-size:26px;font-weight:bold;color:#1b1b1b">${formattedTotal}</p>
    </div>
    <div style="margin:20px 0">
      <p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#4a4a4a;text-transform:uppercase">Message from Copeland Team:</p>
      <div style="padding:16px;background:#f9fafb;border-left:4px solid #b78d44;border-radius:4px;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(quoteMessage)}</div>
    </div>
    <p style="margin-top:24px;font-size:13px;font-weight:bold;color:#4a4a4a;text-transform:uppercase">Requested Items:</p>
    ${itemsTable}
    <p style="margin-top:24px;padding:16px;background:#f3f4f6;border-radius:6px;font-size:14px;color:#1f2937">
      To accept this quote or discuss custom specifications, simply <strong>reply directly to this email</strong>.
    </p>
  `;

  return message(to, subject, title, `Your Copeland quote #${shortId}: ${formattedTotal}`, content);
}

export function rfqConfirmationEmail(to: string, name: string, rfqId: string) {
  const shortId = rfqId.slice(0, 8).toUpperCase();
  const title = 'Quote request received';
  const subject = `Copeland RFQ received #${shortId}`;
  return message(
    to,
    subject,
    title,
    `We have received your quote request #${shortId}`,
    `<p>Hello ${escapeHtml(name)},</p>
     <p>Thank you for submitting your bulk quote request (reference <strong>#${shortId}</strong>).</p>
     <p>Our team is currently reviewing your requested items and volumes. We will reply by email shortly with an official quotation and fulfillment timeline.</p>
     <p style="margin-top:20px;font-size:13px;color:#6b7280">If you have any urgent inquiries, you can reply directly to this email with your reference number.</p>`,
  );
}

export function rfqAdminAlertEmail(
  to: string,
  rfq: { id: string; requesterName: string; requesterEmail: string; itemCount: number },
) {
  const shortId = rfq.id.slice(0, 8).toUpperCase();
  const title = `New RFQ submitted #${shortId}`;
  return message(
    to,
    `[Copeland Admin] New RFQ #${shortId} from ${rfq.requesterName}`,
    title,
    `New RFQ #${shortId} with ${rfq.itemCount} items`,
    `<p>A new request for quote has been submitted on Copeland:</p>
     <ul>
       <li><strong>Reference:</strong> #${shortId}</li>
       <li><strong>Requester:</strong> ${escapeHtml(rfq.requesterName)} (${escapeHtml(rfq.requesterEmail)})</li>
       <li><strong>Items Count:</strong> ${rfq.itemCount}</li>
     </ul>
     <p>Please sign in to the admin dashboard to review and prepare a quotation.</p>`,
  );
}
