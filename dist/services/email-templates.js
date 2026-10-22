import { escapeHtml } from './notifications.service.js';
function layout(title, preview, content) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4f5f7;font-family:Arial,sans-serif;color:#202124"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preview)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;background:#f4f5f7"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:8px"><tr><td style="padding:32px"><p style="margin:0 0 24px;font-size:20px;font-weight:bold">Copeland</p><h1 style="font-size:24px">${escapeHtml(title)}</h1>${content}<p style="margin-top:32px;color:#6b7280;font-size:13px">Copeland Clothiers Limited · copeland.africa</p></td></tr></table></td></tr></table></body></html>`;
}
function button(label, url) {
    return `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(label)}</a></p>`;
}
function message(to, subject, title, preview, content) {
    return { to, subject, html: layout(title, preview, content) };
}
export function verificationEmail(to, name, url) {
    const title = 'Verify your email address';
    return message(to, title, title, 'Confirm your email to finish setting up your Copeland account.', `<p>Hello ${escapeHtml(name)},</p><p>Confirm your email address to secure your account and continue.</p>${button('Verify email address', url)}<p>If you did not create a Copeland account, you can ignore this email.</p>`);
}
export function welcomeEmail(to, name, signInUrl) {
    const title = 'Welcome to Copeland';
    return message(to, title, title, 'Your Copeland account is ready.', `<p>Hello ${escapeHtml(name)},</p><p>Welcome to copeland.africa, a platform connecting buyers with clothing suppliers and shipping partners.</p><p>Verify your email address before signing in.</p>${button('Go to Copeland', signInUrl)}<p>For your security, Copeland will never ask you to send your password by email.</p>`);
}
export function passwordResetEmail(to, name, url) {
    const title = 'Reset your Copeland password';
    return message(to, title, title, 'Use the secure link to choose a new password.', `<p>Hello ${escapeHtml(name)},</p><p>We received a request to reset the password for your account. This link expires according to the reset request window.</p>${button('Reset password', url)}<p>If you did not request this, ignore this message. Your password will not change.</p>`);
}
export function passwordResetConfirmationEmail(to, name) {
    const title = 'Your password was changed';
    return message(to, title, title, 'Your Copeland account password has been updated.', `<p>Hello ${escapeHtml(name)},</p><p>Your Copeland password was successfully changed. If you did not make this change, reset your password immediately and contact Copeland support.</p>`);
}
export function partnerApplicationReceivedEmail(to, name) {
    const title = 'Partner application received';
    return message(to, `Copeland partner application received`, title, 'We received your partner application.', `<p>Hello ${escapeHtml(name)},</p><p>We received your partner application and will review it. We will email you when its status changes.</p>`);
}
export function partnerReviewEmail(to, name, status, note, signInUrl) {
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
export function productModerationEmail(to, productName, subject, reason) {
    const title = subject;
    const details = reason ? `<p>${escapeHtml(reason)}</p>` : '';
    return message(to, subject, title, `There is an update about ${productName}.`, `<p>Your product <strong>${escapeHtml(productName)}</strong> has a moderation update.</p>${details}`);
}
export function orderConfirmationEmail(to, orderNumber, itemNames) {
    const title = `Order ${orderNumber} confirmed`;
    const items = itemNames.map((name) => `<li>${escapeHtml(name)}</li>`).join('');
    return message(to, `Copeland order ${orderNumber} confirmed`, title, 'Your payment has been confirmed.', `<p>Your payment has been confirmed for order <strong>${escapeHtml(orderNumber)}</strong>.</p>${items ? `<ul>${items}</ul>` : ''}`);
}
export function orderStatusEmail(to, orderNumber, status) {
    const title = `Order ${orderNumber} ${status}`;
    return message(to, `Copeland order ${orderNumber} ${status}`, title, `Your order has been ${status}.`, `<p>Order <strong>${escapeHtml(orderNumber)}</strong> has been ${status}.</p>`);
}
export function payoutSentEmail(to, amountKobo, reference) {
    const title = 'Copeland payout sent';
    return message(to, title, title, 'A payout has been recorded for your account.', `<p>A payout of ${amountKobo.toLocaleString('en-NG')} kobo was sent.</p><p>Reference: <strong>${escapeHtml(reference)}</strong></p>`);
}
