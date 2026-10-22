import { Router } from 'express';
import { PayoutService } from '../services/payouts.service.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { ledgerEntries, payouts } from '../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { requireApprovedPartner } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { manualPayoutSchema } from '../validation/schemas.js';
import { apiError } from '../http/responses.js';

export const settlementsRouter = Router();

// Admin triggers payout for an order
settlementsRouter.post('/payout/:orderId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const result = await PayoutService.initiateSupplierPayout(orderId, req.user!.id);
    res.json({
      message: 'Payout initiated successfully',
      ...result
    });
  } catch (error: any) {
    res.status(400).json(apiError('PAYOUT_INITIATION_FAILED', error instanceof Error ? error.message : 'Unable to initiate payout'));
  }
});

settlementsRouter.post('/payout-items/:orderItemId/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const payout = await PayoutService.approveOrderItemPayout(String(req.params.orderItemId), req.user!.id);
    res.json(payout);
  } catch (error) {
    res.status(400).json(apiError('PAYOUT_APPROVAL_FAILED', error instanceof Error ? error.message : 'Unable to approve payout'));
  }
});

settlementsRouter.post('/payout-items/:orderItemId/manual', requireAuth, requireRole('admin'), validateBody(manualPayoutSchema), async (req, res) => {
  try {
    const { reference } = req.body as { reference?: string };
    if (typeof reference !== 'string' || !reference.trim()) {
      return res.status(400).json(apiError('INVALID_MANUAL_PAYOUT', 'Bank-transfer reference is required'));
    }
    const payout = await PayoutService.recordManualPayout(String(req.params.orderItemId), reference, req.user!.id);
    res.json(payout);
  } catch (error) {
    res.status(400).json(apiError('MANUAL_PAYOUT_FAILED', error instanceof Error ? error.message : 'Unable to record manual payout'));
  }
});

// Get all payouts
settlementsRouter.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const allPayouts = await db.select().from(payouts);
  res.json(allPayouts);
});

settlementsRouter.get('/statement', requireAuth, requireRole('supplier'), requireApprovedPartner, async (req, res) => {
  const partnerId = req.partnerId!;
  const [balance] = await db.select({
    amount: sql<string>`COALESCE(SUM(${ledgerEntries.amountKobo}), 0)::text`,
  }).from(ledgerEntries).where(eq(ledgerEntries.partnerId, partnerId));
  const entries = await db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.partnerId, partnerId))
    .orderBy(sql`${ledgerEntries.createdAt} DESC`);
  res.json({ balanceKobo: balance.amount, entries });
});
