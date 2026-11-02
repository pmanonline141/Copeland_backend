import { Router } from 'express';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  auditLog,
  ledgerEntries,
  moderationRecords,
  orderItems,
  orders,
  partners,
  payoutItems,
  productInventory,
  products,
  rfqRequests,
  shipments,
  shipmentUpdates,
} from '../db/schema/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { adjustmentSchema } from '../validation/schemas.js';
import { apiError } from '../http/responses.js';

export const adminRouter = Router();

// ==========================================
// 1. Analytics & Comprehensive System Stats
// ==========================================

adminRouter.get('/analytics', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
  try {
    const salesByDay = await db.execute(sql`
      SELECT date_trunc('day', created_at)::date AS day, SUM(amount_kobo)::text AS sales_kobo
      FROM ledger_entries
      WHERE entry_type = 'item_sale'
      GROUP BY day ORDER BY day DESC LIMIT 90
    `);

    const salesBySupplier = await db.execute(sql`
      SELECT p.id AS partner_id, p.business_name, SUM(l.amount_kobo)::text AS sales_kobo
      FROM ledger_entries l
      JOIN partners p ON p.id = l.partner_id
      WHERE l.entry_type = 'item_sale'
      GROUP BY p.id, p.business_name ORDER BY SUM(l.amount_kobo) DESC
    `);

    const commissionEarned = await db.execute(sql`
      SELECT COALESCE(-SUM(amount_kobo), 0)::text AS commission_kobo
      FROM ledger_entries WHERE entry_type = 'commission'
    `);

    const pendingPayouts = await db.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::text AS pending_payout_kobo
      FROM payout_items WHERE status IN ('pending', 'approved', 'initiated', 'failed')
    `);

    // Products breakdown
    const productCountsRaw = await db.execute(sql`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'changes_requested')::int AS changes_requested,
        COUNT(*) FILTER (WHERE status = 'paused')::int AS paused,
        COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
        COUNT(*) FILTER (WHERE is_copeland_label = true)::int AS badged
      FROM products
    `);

    // Orders breakdown
    const orderCountsRaw = await db.execute(sql`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE requires_admin_review = true)::int AS flagged,
        COUNT(*) FILTER (WHERE status = 'pending_payment')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'shipped')::int AS shipped,
        COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        COALESCE(SUM(total_amount_kobo) FILTER (WHERE status IN ('paid', 'processing', 'shipped', 'delivered')), 0)::text AS total_gmv_kobo
      FROM orders
    `);

    // Partners breakdown
    const partnerCountsRaw = await db.execute(sql`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE partner_type = 'supplier')::int AS suppliers,
        COUNT(*) FILTER (WHERE partner_type = 'shipping')::int AS shipping,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended
      FROM partners
    `);

    // RFQs breakdown
    const rfqCountsRaw = await db.execute(sql`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'new')::int AS new,
        COUNT(*) FILTER (WHERE status = 'in_review')::int AS in_review,
        COUNT(*) FILTER (WHERE status = 'quoted')::int AS quoted,
        COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
        COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
        COALESCE(SUM(quote_amount_kobo) FILTER (WHERE status IN ('quoted', 'accepted')), 0)::text AS total_quoted_kobo
      FROM rfq_requests
    `);

    res.json({
      salesByDay: salesByDay.rows ?? salesByDay,
      salesBySupplier: salesBySupplier.rows ?? salesBySupplier,
      commissionEarned: (commissionEarned.rows?.[0] as any)?.commission_kobo ?? '0',
      pendingPayouts: (pendingPayouts.rows?.[0] as any)?.pending_payout_kobo ?? '0',
      productsStats: (productCountsRaw.rows?.[0] as any) ?? {},
      ordersStats: (orderCountsRaw.rows?.[0] as any) ?? {},
      partnersStats: (partnerCountsRaw.rows?.[0] as any) ?? {},
      rfqsStats: (rfqCountsRaw.rows?.[0] as any) ?? {},
    });
  } catch (error) {
    res.status(500).json(apiError('ANALYTICS_FAILED', error instanceof Error ? error.message : 'Unable to compute analytics'));
  }
});

// ==========================================
// 2. Products Management & Review Queue
// ==========================================

// Legacy review queue endpoint (for backward compatibility)
adminRouter.get('/products/review', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
  const reviewQueue = await db.select().from(products).where(eq(products.status, 'submitted')).orderBy(desc(products.createdAt));
  res.json(reviewQueue);
});

// Full searchable, filterable, paginated products list for Admin
adminRouter.get('/products', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
    const category = typeof req.query.category === 'string' && req.query.category !== 'all' ? req.query.category : undefined;
    const tier = typeof req.query.tier === 'string' && req.query.tier !== 'all' ? req.query.tier : undefined;
    const partnerId = typeof req.query.partnerId === 'string' ? req.query.partnerId : undefined;
    const isCopelandLabel = req.query.isCopelandLabel === 'true' ? true : req.query.isCopelandLabel === 'false' ? false : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const conditions = [];
    if (status) conditions.push(eq(products.status, status));
    if (category) conditions.push(eq(products.category, category));
    if (tier) conditions.push(eq(products.tier, tier));
    if (partnerId) conditions.push(eq(products.partnerId, partnerId));
    if (isCopelandLabel !== undefined) conditions.push(eq(products.isCopelandLabel, isCopelandLabel));
    if (search) {
      conditions.push(
        or(
          ilike(products.name, `%${search}%`),
          ilike(products.description, `%${search}%`),
          ilike(products.category, `%${search}%`),
          ilike(partners.businessName, `%${search}%`),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(products)
      .leftJoin(partners, eq(products.partnerId, partners.id))
      .where(whereClause);

    const total = countResult?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const rows = await db
      .select({
        product: products,
        supplierName: partners.businessName,
        supplierEmail: partners.contactEmail,
        supplierType: partners.partnerType,
      })
      .from(products)
      .leftJoin(partners, eq(products.partnerId, partners.id))
      .where(whereClause)
      .orderBy(desc(products.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const items = rows.map(({ product, supplierName, supplierEmail, supplierType }) => ({
      ...product,
      supplier: {
        id: product.partnerId,
        name: supplierName ?? 'Unknown Supplier',
        email: supplierEmail ?? null,
        type: supplierType ?? 'supplier',
      },
    }));

    res.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    res.status(500).json(apiError('PRODUCTS_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to list products'));
  }
});

// Single product detail for admin inspection
adminRouter.get('/products/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const productId = String(req.params.id);
    const [row] = await db
      .select({
        product: products,
        supplier: partners,
      })
      .from(products)
      .leftJoin(partners, eq(products.partnerId, partners.id))
      .where(eq(products.id, productId));

    if (!row) return res.status(404).json(apiError('PRODUCT_NOT_FOUND', 'Product not found'));

    const inventory = await db.select().from(productInventory).where(eq(productInventory.productId, productId));
    const moderationHistory = await db.select().from(moderationRecords).where(eq(moderationRecords.productId, productId)).orderBy(desc(moderationRecords.createdAt));

    res.json({
      ...row.product,
      inventory,
      supplier: row.supplier,
      moderationHistory,
    });
  } catch (error) {
    res.status(500).json(apiError('PRODUCT_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to fetch product details'));
  }
});

// ==========================================
// 3. Orders Oversight & Resolution
// ==========================================

// Legacy flagged orders endpoint
adminRouter.get('/orders/flagged', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
  const flaggedOrders = await db.select().from(orders).where(eq(orders.requiresAdminReview, true)).orderBy(desc(orders.createdAt));
  res.json(flaggedOrders);
});

// Full searchable, filterable, paginated orders list for Admin
adminRouter.get('/orders', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
    const requiresAdminReview = req.query.requiresAdminReview === 'true' ? true : req.query.requiresAdminReview === 'false' ? false : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const conditions = [];
    if (status) conditions.push(eq(orders.status, status));
    if (requiresAdminReview !== undefined) conditions.push(eq(orders.requiresAdminReview, requiresAdminReview));
    if (search) {
      conditions.push(
        or(
          ilike(orders.orderNumber, `%${search}%`),
          ilike(orders.buyerEmail, `%${search}%`),
          ilike(orders.buyerName, `%${search}%`),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(orders)
      .where(whereClause);

    const total = countResult?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const rows = await db
      .select({
        order: orders,
        shippingPartnerName: partners.businessName,
      })
      .from(orders)
      .leftJoin(partners, eq(orders.shippingPartnerId, partners.id))
      .where(whereClause)
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    // Fetch items count per order
    const orderIds = rows.map((r) => r.order.id);
    const itemCounts = orderIds.length > 0
      ? await db
          .select({
            orderId: orderItems.orderId,
            itemCount: sql<number>`COUNT(*)::int`,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds))
          .groupBy(orderItems.orderId)
      : [];

    const countMap = new Map(itemCounts.map((i) => [i.orderId, i.itemCount]));

    const items = rows.map(({ order, shippingPartnerName }) => ({
      ...order,
      totalKobo: order.totalAmountKobo,
      itemCount: countMap.get(order.id) ?? 0,
      shippingPartnerName: shippingPartnerName ?? null,
    }));

    res.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    res.status(500).json(apiError('ORDERS_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to list orders'));
  }
});

// Single order detail for admin inspection & fulfillment reallocation
adminRouter.get('/orders/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const orderId = String(req.params.id);
    const [orderRow] = await db
      .select({
        order: orders,
        shippingPartner: partners,
      })
      .from(orders)
      .leftJoin(partners, eq(orders.shippingPartnerId, partners.id))
      .where(eq(orders.id, orderId));

    if (!orderRow) return res.status(404).json(apiError('ORDER_NOT_FOUND', 'Order not found'));

    const items = await db
      .select({
        item: orderItems,
        product: products,
        supplierName: partners.businessName,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(partners, eq(products.partnerId, partners.id))
      .where(eq(orderItems.orderId, orderId));

    const orderShipments = await db.select().from(shipments).where(eq(shipments.orderId, orderId));
    const shipmentIds = orderShipments.map((s) => s.id);
    const updates = shipmentIds.length > 0
      ? await db.select().from(shipmentUpdates).where(inArray(shipmentUpdates.shipmentId, shipmentIds)).orderBy(desc(shipmentUpdates.createdAt))
      : [];

    res.json({
      ...orderRow.order,
      totalKobo: orderRow.order.totalAmountKobo,
      shippingPartner: orderRow.shippingPartner,
      items: items.map((i) => {
        const unitPrice = i.item.priceKoboAtPurchase;
        const qty = i.item.quantity ?? 1;
        return {
          ...i.item,
          productName: i.product?.name ?? 'Item',
          unitPriceKobo: unitPrice,
          subtotalKobo: unitPrice * qty,
          product: i.product,
          supplierName: i.supplierName,
        };
      }),
      shipments: orderShipments.map((s) => ({
        ...s,
        updates: updates.filter((u) => u.shipmentId === s.id),
      })),
    });
  } catch (error) {
    res.status(500).json(apiError('ORDER_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to fetch order'));
  }
});

// Admin resolution for flagged orders
adminRouter.post('/orders/:id/resolve', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const orderId = String(req.params.id);
    const { resolutionNote, requiresAdminReview } = req.body as {
      resolutionNote?: string;
      requiresAdminReview?: boolean;
    };

    const [updated] = await db
      .update(orders)
      .set({
        requiresAdminReview: requiresAdminReview ?? false,
        adminReviewReason: resolutionNote?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();

    if (!updated) return res.status(404).json(apiError('ORDER_NOT_FOUND', 'Order not found'));

    await db.insert(auditLog).values({
      actorId: req.user!.id,
      action: 'order.resolve',
      entityType: 'order',
      entityId: updated.id,
      details: { resolutionNote, requiresAdminReview: updated.requiresAdminReview },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json(apiError('ORDER_RESOLVE_FAILED', error instanceof Error ? error.message : 'Unable to resolve order'));
  }
});

// ==========================================
// 4. Quote Requests (RFQs) Management
// ==========================================

adminRouter.get('/rfqs', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const conditions = [];
    if (status) conditions.push(eq(rfqRequests.status, status));
    if (search) {
      conditions.push(
        or(
          ilike(rfqRequests.requesterName, `%${search}%`),
          ilike(rfqRequests.requesterEmail, `%${search}%`),
          ilike(rfqRequests.details, `%${search}%`),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(rfqRequests)
      .where(whereClause);

    const total = countResult?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const items = await db
      .select()
      .from(rfqRequests)
      .where(whereClause)
      .orderBy(desc(rfqRequests.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    res.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    res.status(500).json(apiError('RFQS_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to list RFQs'));
  }
});

adminRouter.get('/rfq-counts', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
  const rfqs = await db.select({
    status: rfqRequests.status,
    count: sql<number>`COUNT(*)::int`,
  }).from(rfqRequests).groupBy(rfqRequests.status);
  res.json(rfqs);
});

// ==========================================
// 5. Payouts & Settlements Management
// ==========================================

adminRouter.get('/payouts', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const conditions = [];
    if (status) conditions.push(eq(payoutItems.status, status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(payoutItems)
      .where(whereClause);

    const total = countResult?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const rows = await db
      .select({
        payout: payoutItems,
        partnerName: partners.businessName,
        recipientCode: partners.paystackRecipientCode,
      })
      .from(payoutItems)
      .leftJoin(partners, eq(payoutItems.partnerId, partners.id))
      .where(whereClause)
      .orderBy(desc(payoutItems.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const items = rows.map(({ payout, partnerName, recipientCode }) => ({
      ...payout,
      partnerName: partnerName ?? null,
      recipientCode: recipientCode ?? null,
    }));

    res.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    res.status(500).json(apiError('PAYOUTS_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to list payouts'));
  }
});

adminRouter.post('/partners/:partnerId/adjustments', requireAuth, requireRole('admin'), validateBody(adjustmentSchema), async (req, res) => {
  try {
    const { amountKobo, note, orderId } = req.body as {
      amountKobo?: number;
      note?: string;
      orderId?: string;
    };
    if (!Number.isSafeInteger(amountKobo) || amountKobo === 0 || !note?.trim()) {
      return res.status(400).json(apiError('INVALID_LEDGER_ADJUSTMENT', 'A non-zero integer amount in kobo and an adjustment note are required'));
    }

    const adjustment = await db.transaction(async (tx) => {
      const [partner] = await tx.select({ id: partners.id }).from(partners)
        .where(eq(partners.id, String(req.params.partnerId)));
      if (!partner) throw new Error('Partner not found');

      const [entry] = await tx.insert(ledgerEntries).values({
        orderId: orderId ?? null,
        partnerId: partner.id,
        entryType: 'adjustment',
        amountKobo: amountKobo!,
        description: note.trim(),
        adjustmentNote: note.trim(),
      }).returning();

      await tx.insert(auditLog).values({
        actorId: req.user!.id,
        action: 'ledger.adjustment',
        entityType: 'ledger_entry',
        entityId: entry.id,
        details: { partnerId: partner.id, amountKobo, note: note.trim() },
      });
      return entry;
    });
    res.status(201).json(adjustment);
  } catch (error) {
    res.status(400).json(apiError('LEDGER_ADJUSTMENT_FAILED', error instanceof Error ? error.message : 'Unable to record adjustment'));
  }
});

adminRouter.get('/partners/:partnerId/statement', requireAuth, requireRole('admin'), async (req, res) => {
  const partnerId = String(req.params.partnerId);
  const [partner] = await db.select({ id: partners.id, businessName: partners.businessName })
    .from(partners).where(eq(partners.id, partnerId));
  if (!partner) return res.status(404).json(apiError('PARTNER_NOT_FOUND', 'Partner not found'));
  const [balance] = await db.select({
    amount: sql<string>`COALESCE(SUM(${ledgerEntries.amountKobo}), 0)::text`,
  }).from(ledgerEntries).where(eq(ledgerEntries.partnerId, partnerId));
  const entries = await db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.partnerId, partnerId))
    .orderBy(sql`${ledgerEntries.createdAt} DESC`);
  res.json({ partner, balanceKobo: balance.amount, entries });
});

// ==========================================
// 6. Audit Trail & Governance
// ==========================================

adminRouter.get('/audit-log', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const action = typeof req.query.action === 'string' && req.query.action !== 'all' ? req.query.action : undefined;
    const entityType = typeof req.query.entityType === 'string' && req.query.entityType !== 'all' ? req.query.entityType : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const conditions = [];
    if (action) conditions.push(eq(auditLog.action, action));
    if (entityType) conditions.push(eq(auditLog.entityType, entityType));
    if (search) {
      conditions.push(
        or(
          ilike(auditLog.actorId, `%${search}%`),
          ilike(auditLog.entityId, `%${search}%`),
          ilike(auditLog.action, `%${search}%`),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(auditLog)
      .where(whereClause);

    const total = countResult?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const items = await db
      .select()
      .from(auditLog)
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    res.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    res.status(500).json(apiError('AUDIT_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to fetch audit log'));
  }
});
