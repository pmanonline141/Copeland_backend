import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, ledgerEntries, orders, partners, payoutItems, products, rfqRequests, } from '../db/schema/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { adjustmentSchema } from '../validation/schemas.js';
import { apiError } from '../http/responses.js';
export const adminRouter = Router();
adminRouter.get('/products/review', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
    const reviewQueue = await db.select().from(products).where(eq(products.status, 'submitted'));
    res.json(reviewQueue);
});
adminRouter.get('/orders/flagged', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
    const flaggedOrders = await db.select().from(orders).where(eq(orders.requiresAdminReview, true));
    res.json(flaggedOrders);
});
adminRouter.get('/payouts', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const filters = status ? eq(payoutItems.status, status) : undefined;
    res.json(await db.select().from(payoutItems).where(filters));
});
adminRouter.get('/audit-log', requireAuth, requireRole('admin'), async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(await db.select().from(auditLog).orderBy(sql `${auditLog.createdAt} DESC`).limit(limit));
});
adminRouter.post('/partners/:partnerId/adjustments', requireAuth, requireRole('admin'), validateBody(adjustmentSchema), async (req, res) => {
    try {
        const { amountKobo, note, orderId } = req.body;
        if (!Number.isSafeInteger(amountKobo) || amountKobo === 0 || !note?.trim()) {
            return res.status(400).json(apiError('INVALID_LEDGER_ADJUSTMENT', 'A non-zero integer amount in kobo and an adjustment note are required'));
        }
        const adjustment = await db.transaction(async (tx) => {
            const [partner] = await tx.select({ id: partners.id }).from(partners)
                .where(eq(partners.id, String(req.params.partnerId)));
            if (!partner)
                throw new Error('Partner not found');
            const [entry] = await tx.insert(ledgerEntries).values({
                orderId: orderId ?? null,
                partnerId: partner.id,
                entryType: 'adjustment',
                amountKobo: amountKobo,
                description: note.trim(),
                adjustmentNote: note.trim(),
            }).returning();
            await tx.insert(auditLog).values({
                actorId: req.user.id,
                action: 'ledger.adjustment',
                entityType: 'ledger_entry',
                entityId: entry.id,
                details: { partnerId: partner.id, amountKobo, note: note.trim() },
            });
            return entry;
        });
        res.status(201).json(adjustment);
    }
    catch (error) {
        res.status(400).json(apiError('LEDGER_ADJUSTMENT_FAILED', error instanceof Error ? error.message : 'Unable to record adjustment'));
    }
});
adminRouter.get('/partners/:partnerId/statement', requireAuth, requireRole('admin'), async (req, res) => {
    const partnerId = String(req.params.partnerId);
    const [partner] = await db.select({ id: partners.id, businessName: partners.businessName })
        .from(partners).where(eq(partners.id, partnerId));
    if (!partner)
        return res.status(404).json(apiError('PARTNER_NOT_FOUND', 'Partner not found'));
    const [balance] = await db.select({
        amount: sql `COALESCE(SUM(${ledgerEntries.amountKobo}), 0)::text`,
    }).from(ledgerEntries).where(eq(ledgerEntries.partnerId, partnerId));
    const entries = await db.select().from(ledgerEntries)
        .where(eq(ledgerEntries.partnerId, partnerId))
        .orderBy(sql `${ledgerEntries.createdAt} DESC`);
    res.json({ partner, balanceKobo: balance.amount, entries });
});
adminRouter.get('/analytics', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
    const salesByDay = await db.execute(sql `
    SELECT date_trunc('day', created_at)::date AS day, SUM(amount_kobo)::text AS sales_kobo
    FROM ledger_entries
    WHERE entry_type = 'item_sale'
    GROUP BY day ORDER BY day DESC LIMIT 90
  `);
    const salesBySupplier = await db.execute(sql `
    SELECT p.id AS partner_id, p.business_name, SUM(l.amount_kobo)::text AS sales_kobo
    FROM ledger_entries l
    JOIN partners p ON p.id = l.partner_id
    WHERE l.entry_type = 'item_sale'
    GROUP BY p.id, p.business_name ORDER BY SUM(l.amount_kobo) DESC
  `);
    const commissionEarned = await db.execute(sql `
    SELECT COALESCE(-SUM(amount_kobo), 0)::text AS commission_kobo
    FROM ledger_entries WHERE entry_type = 'commission'
  `);
    const pendingPayouts = await db.execute(sql `
    SELECT COALESCE(SUM(amount_kobo), 0)::text AS pending_payout_kobo
    FROM payout_items WHERE status IN ('pending', 'approved', 'initiated', 'failed')
  `);
    res.json({ salesByDay, salesBySupplier, commissionEarned, pendingPayouts });
});
adminRouter.get('/rfq-counts', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
    const rfqs = await db.select({
        status: rfqRequests.status,
        count: sql `COUNT(*)::int`,
    }).from(rfqRequests).groupBy(rfqRequests.status);
    res.json(rfqs);
});
