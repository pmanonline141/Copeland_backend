import { Router } from 'express';
import crypto from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ledgerEntries, orderItems, orders, partners, payments, payoutItems, products, auditLog, webhookEvents, } from '../db/schema/index.js';
import { sendTransactionalEmail } from '../services/notifications.service.js';
import { orderConfirmationEmail, payoutSentEmail } from '../services/email-templates.js';
import { webhookRateLimit } from '../middleware/rate-limits.js';
import { apiError } from '../http/responses.js';
export const webhookRouter = Router();
function hasValidSignature(rawBody, signature, secret) {
    if (!signature)
        return false;
    const expected = crypto.createHmac('sha512', secret).update(rawBody).digest();
    let received;
    try {
        received = Buffer.from(signature, 'hex');
    }
    catch {
        return false;
    }
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
async function verifyCharge(reference) {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const result = await response.json();
    if (!response.ok || !result.status || result.data?.reference !== reference) {
        throw new Error(result.message ?? 'Paystack could not verify this transaction');
    }
    return result;
}
webhookRouter.post('/paystack', webhookRateLimit, async (req, res) => {
    const rawBody = req.body;
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!Buffer.isBuffer(rawBody) || !secret) {
        return res.status(400).json(apiError('INVALID_WEBHOOK', 'Webhook body or configuration is invalid'));
    }
    if (!hasValidSignature(rawBody, req.headers['x-paystack-signature'], secret)) {
        return res.status(401).json(apiError('INVALID_SIGNATURE', 'Invalid webhook signature'));
    }
    let event;
    try {
        event = JSON.parse(rawBody.toString('utf8'));
    }
    catch {
        return res.status(400).json(apiError('INVALID_WEBHOOK', 'Webhook payload is not valid JSON'));
    }
    const eventType = event.event;
    const reference = event.data?.reference;
    if (!eventType || !reference) {
        return res.status(400).json(apiError('INVALID_WEBHOOK', 'Webhook event type and reference are required'));
    }
    let verification;
    if (eventType === 'charge.success') {
        try {
            verification = await verifyCharge(reference);
        }
        catch (error) {
            return res.status(502).json(apiError('PAYMENT_VERIFICATION_FAILED', error instanceof Error ? error.message : 'Payment verification failed'));
        }
    }
    const eventKey = event.data?.id !== undefined
        ? String(event.data.id)
        : `${eventType}:${reference}`;
    let queuedEmail;
    await db.transaction(async (tx) => {
        const [recorded] = await tx.insert(webhookEvents).values({
            provider: 'paystack',
            eventKey,
            eventType,
            payload: event,
        }).onConflictDoNothing().returning({ id: webhookEvents.id });
        if (!recorded)
            return;
        if (eventType === 'charge.success' && verification?.data) {
            const [payment] = await tx.select().from(payments).where(eq(payments.reference, reference));
            if (!payment)
                return;
            await tx.execute(sql `SELECT id FROM orders WHERE id = ${payment.orderId} FOR UPDATE`);
            const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId));
            if (!order)
                return;
            const verifiedData = verification.data;
            const amountMatches = Number.isSafeInteger(verifiedData.amount)
                && verifiedData.amount === order.totalAmountKobo
                && payment.amountKobo === order.totalAmountKobo;
            const currencyMatches = verifiedData.currency === order.currency;
            if (!amountMatches || !currencyMatches || order.status !== 'pending_payment') {
                const reason = order.status === 'paid'
                    ? 'Payment success received after the order was already paid'
                    : order.status !== 'pending_payment'
                        ? `Payment success received for an order in ${order.status} state`
                        : 'Verified payment amount or currency does not match the order';
                await tx.update(orders).set({
                    requiresAdminReview: true,
                    adminReviewReason: reason,
                    updatedAt: new Date(),
                }).where(eq(orders.id, order.id));
                await tx.update(payments).set({
                    status: 'requires_review',
                    providerPayload: verification,
                    updatedAt: new Date(),
                }).where(eq(payments.id, payment.id));
                return;
            }
            await tx.update(orders).set({ status: 'paid', updatedAt: new Date() }).where(eq(orders.id, order.id));
            await tx.update(payments).set({
                status: 'success',
                providerPayload: verification,
                updatedAt: new Date(),
            }).where(eq(payments.id, payment.id));
            const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
            const productNames = [];
            for (const item of items) {
                const [product] = await tx.select().from(products).where(eq(products.id, item.productId));
                if (!product)
                    continue;
                productNames.push(product.name);
                const grossKobo = item.priceKoboAtPurchase * item.quantity;
                await tx.insert(payoutItems).values({
                    orderItemId: item.id,
                    partnerId: product.partnerId,
                    amountKobo: grossKobo - item.commissionAmountKobo,
                    status: 'pending',
                }).onConflictDoNothing();
                await tx.insert(ledgerEntries).values([
                    {
                        orderId: order.id,
                        orderItemId: item.id,
                        partnerId: product.partnerId,
                        entryType: 'item_sale',
                        amountKobo: grossKobo,
                        description: `Sale recorded for order item ${item.id}`,
                    },
                    {
                        orderId: order.id,
                        orderItemId: item.id,
                        partnerId: product.partnerId,
                        entryType: 'commission',
                        amountKobo: -item.commissionAmountKobo,
                        description: `Commission at ${item.commissionRateBps} basis points`,
                    },
                ]).onConflictDoNothing();
            }
            queuedEmail = {
                ...orderConfirmationEmail(order.buyerEmail, order.orderNumber, productNames),
            };
            return;
        }
        const payoutStatuses = {
            'transfer.success': 'success',
            'transfer.failed': 'failed',
            'transfer.reversed': 'reversed',
        };
        const nextStatus = payoutStatuses[eventType];
        if (!nextStatus)
            return;
        const [payout] = await tx.select().from(payoutItems).where(eq(payoutItems.reference, reference));
        if (!payout || payout.status === nextStatus)
            return;
        if ((nextStatus === 'failed' && payout.status !== 'initiated')
            || (nextStatus === 'reversed' && payout.status !== 'success')
            || (nextStatus === 'success' && !['initiated', 'failed'].includes(payout.status)))
            return;
        const [updatedPayout] = await tx.update(payoutItems)
            .set({ status: nextStatus, updatedAt: new Date() })
            .where(and(eq(payoutItems.reference, reference), eq(payoutItems.status, payout.status)))
            .returning();
        if (!updatedPayout)
            return;
        await tx.insert(auditLog).values({
            actorId: null,
            action: `payout.${nextStatus}`,
            entityType: 'payout_item',
            entityId: updatedPayout.orderItemId,
            details: { reference, amountKobo: updatedPayout.amountKobo },
        });
        if (!['success', 'reversed'].includes(nextStatus))
            return;
        const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, updatedPayout.orderItemId));
        if (!item)
            return;
        await tx.insert(ledgerEntries).values({
            orderId: item.orderId,
            orderItemId: item.id,
            payoutItemId: item.id,
            partnerId: updatedPayout.partnerId,
            entryType: nextStatus === 'success' ? 'payout_sent' : 'payout_reversed',
            amountKobo: nextStatus === 'success' ? -updatedPayout.amountKobo : updatedPayout.amountKobo,
            description: `Paystack transfer ${nextStatus}. Ref: ${reference}`,
        }).onConflictDoNothing();
        if (nextStatus === 'success') {
            const orderItemRows = await tx.select({ id: orderItems.id })
                .from(orderItems).where(eq(orderItems.orderId, item.orderId));
            const orderPayouts = await tx.select().from(payoutItems)
                .where(inArray(payoutItems.orderItemId, orderItemRows.map((row) => row.id)));
            if (orderItemRows.length > 0
                && orderPayouts.length === orderItemRows.length
                && orderPayouts.every((row) => row.status === 'success')) {
                await tx.update(orders).set({ status: 'completed', updatedAt: new Date() })
                    .where(eq(orders.id, item.orderId));
            }
        }
        if (nextStatus === 'success') {
            const [partner] = await tx.select().from(partners).where(eq(partners.id, updatedPayout.partnerId));
            if (partner?.contactEmail) {
                queuedEmail = {
                    ...payoutSentEmail(partner.contactEmail, updatedPayout.amountKobo, reference),
                };
            }
        }
    });
    if (queuedEmail)
        await sendTransactionalEmail(queuedEmail);
    return res.sendStatus(200);
});
