import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  orderItems,
  orders,
  partners,
  products,
  rfqRequests,
  shipmentUpdates,
  shipments,
} from '../db/schema/index.js';
import { user } from '../db/schema/auth.js';
import { PayoutService } from './payouts.service.js';
import { sendTransactionalEmail, sendWhatsAppMessage } from './notifications.service.js';
import {
  orderStatusEmail,
  rfqConfirmationEmail,
  rfqAdminAlertEmail,
  rfqQuoteEmail,
} from './email-templates.js';
import { errorLogFields, logger } from '../logger.js';

const itemTransitions: Record<string, string[]> = {
  pending: ['packed'],
  packed: ['shipped'],
  shipped: ['delivered'],
};

export class FulfillmentService {
  static async getSupplierOrders(partnerId: string) {
    const rows = await db.select({ order: orders, item: orderItems, product: products })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(eq(products.partnerId, partnerId));
    const grouped = new Map<string, { order: typeof rows[number]['order']; items: Array<{ item: typeof rows[number]['item']; product: typeof rows[number]['product'] }> }>();
    for (const row of rows) {
      const existing = grouped.get(row.order.id) ?? { order: row.order, items: [] };
      existing.items.push({ item: row.item, product: row.product });
      grouped.set(row.order.id, existing);
    }
    return [...grouped.values()];
  }

  static async updateItemFulfillment(
    orderId: string,
    orderItemId: string,
    partnerId: string,
    nextStatus: 'packed' | 'shipped' | 'delivered',
  ) {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
      const [item] = await tx.select({ item: orderItems, product: products })
        .from(orderItems)
        .innerJoin(products, eq(orderItems.productId, products.id))
        .where(and(
          eq(orderItems.id, orderItemId),
          eq(orderItems.orderId, orderId),
          eq(products.partnerId, partnerId),
        ));
      if (!item) throw new Error('Order item not found or unauthorized');

      if (!itemTransitions[item.item.fulfillmentStatus]?.includes(nextStatus)) {
        throw new Error(`Cannot transition item from ${item.item.fulfillmentStatus} to ${nextStatus}`);
      }

      const now = new Date();
      const [updatedItem] = await tx.update(orderItems)
        .set({
          fulfillmentStatus: nextStatus,
          ...(nextStatus === 'delivered'
            ? { deliveredAt: now, payoutEligibleAt: PayoutService.payoutEligibleAt(now) }
            : {}),
        })
        .where(eq(orderItems.id, orderItemId))
        .returning();

      const allItems = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      const allDelivered = allItems.every((orderItem) => orderItem.fulfillmentStatus === 'delivered');
      const allShippedOrDelivered = allItems.every((orderItem) => ['shipped', 'delivered'].includes(orderItem.fulfillmentStatus));
      const nextOrderStatus = allDelivered ? 'delivered' : allShippedOrDelivered ? 'shipped' : 'processing';
      await tx.update(orders).set({ status: nextOrderStatus, updatedAt: now }).where(eq(orders.id, orderId));

      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      return { updatedItem, order };
    });
    if (outcome.order && (nextStatus === 'shipped' || nextStatus === 'delivered')) {
      await sendTransactionalEmail(orderStatusEmail(
        outcome.order.buyerEmail,
        outcome.order.orderNumber,
        nextStatus,
      ));
    }
    return outcome.updatedItem;
  }

  static async assignShippingPartner(orderId: string, shippingPartnerId: string) {
    const [partner] = await db.select().from(partners).where(eq(partners.id, shippingPartnerId));
    if (!partner || partner.partnerType !== 'shipping' || partner.status !== 'approved') {
      throw new Error('An approved shipping partner is required');
    }
    const [order] = await db.update(orders)
      .set({ shippingPartnerId, updatedAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    if (!order) throw new Error('Order not found');
    return order;
  }

  /**
   * Orders Copeland has handed to this shipping partner (everything past payment),
   * each with its line items and any shipments already recorded for it.
   */
  static async getShippingAssignments(partnerId: string) {
    const rows = await db.select({ order: orders, item: orderItems, product: products })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(and(
        eq(orders.shippingPartnerId, partnerId),
        inArray(orders.status, ['paid', 'processing', 'shipped', 'delivered']),
      ))
      .orderBy(desc(orders.createdAt));

    const grouped = new Map<string, {
      order: typeof rows[number]['order'];
      items: Array<{ id: string; productName: string; quantity: number; size: string | null; colour: string | null }>;
    }>();
    for (const row of rows) {
      const existing = grouped.get(row.order.id) ?? { order: row.order, items: [] };
      existing.items.push({
        id: row.item.id,
        productName: row.product?.name ?? 'Item',
        quantity: row.item.quantity,
        size: row.item.size,
        colour: row.item.colour,
      });
      grouped.set(row.order.id, existing);
    }

    const orderIds = [...grouped.keys()];
    if (orderIds.length === 0) return [];

    const shipmentRows = await db.select().from(shipments)
      .where(inArray(shipments.orderId, orderIds));
    const shipmentIds = shipmentRows.map((s) => s.id);
    const updates = shipmentIds.length > 0
      ? await db.select().from(shipmentUpdates)
          .where(inArray(shipmentUpdates.shipmentId, shipmentIds))
          .orderBy(desc(shipmentUpdates.createdAt))
      : [];

    return [...grouped.values()].map(({ order, items }) => ({
      order: { ...order, totalKobo: order.totalAmountKobo },
      items,
      shipments: shipmentRows
        .filter((s) => s.orderId === order.id)
        .map((s) => ({ ...s, updates: updates.filter((u) => u.shipmentId === s.id) })),
    }));
  }

  static async createShipment(orderId: string, shippingPartnerId: string, trackingNumber: string) {
    const [order] = await db.select().from(orders).where(and(
      eq(orders.id, orderId),
      eq(orders.shippingPartnerId, shippingPartnerId),
    ));
    if (!order || !['paid', 'processing', 'shipped'].includes(order.status)) {
      throw new Error('Order is not assigned to this shipping partner or is not ready to ship');
    }

    const [shipment] = await db.insert(shipments).values({
      orderId,
      shippingPartnerId,
      trackingNumber: trackingNumber.trim(),
      status: 'created',
    }).returning();
    await db.insert(shipmentUpdates).values({
      shipmentId: shipment.id,
      status: 'created',
      note: 'Shipment created',
    });
    return shipment;
  }

  static async updateShipment(
    shipmentId: string,
    shippingPartnerId: string,
    status: 'picked_up' | 'in_transit' | 'delivered',
    note?: string,
  ) {
    const transitions: Record<string, string[]> = {
      created: ['picked_up'],
      picked_up: ['in_transit'],
      in_transit: ['delivered'],
    };

    const outcome = await db.transaction(async (tx) => {
      const [shipment] = await tx.select().from(shipments).where(and(
        eq(shipments.id, shipmentId),
        eq(shipments.shippingPartnerId, shippingPartnerId),
      ));
      if (!shipment) throw new Error('Shipment not found or unauthorized');
      if (!transitions[shipment.status]?.includes(status)) {
        throw new Error(`Cannot transition shipment from ${shipment.status} to ${status}`);
      }

      const [updated] = await tx.update(shipments)
        .set({ status, updatedAt: new Date() })
        .where(eq(shipments.id, shipmentId))
        .returning();
      await tx.insert(shipmentUpdates).values({ shipmentId, status, note: note?.trim() || null });

      if (status === 'delivered') {
        const now = new Date();
        const orderItemsForShipment = await tx.select().from(orderItems)
          .where(eq(orderItems.orderId, shipment.orderId));
        for (const item of orderItemsForShipment) {
          if (item.fulfillmentStatus !== 'delivered') {
            await tx.update(orderItems).set({
              fulfillmentStatus: 'delivered',
              deliveredAt: now,
              payoutEligibleAt: PayoutService.payoutEligibleAt(now),
            }).where(eq(orderItems.id, item.id));
          }
        }
        await tx.update(orders)
          .set({ status: 'delivered', updatedAt: now })
          .where(eq(orders.id, shipment.orderId));
      } else if (status === 'in_transit') {
        // A parcel on the road means the order is now shipped on the buyer's side too.
        await tx.update(orders)
          .set({ status: 'shipped', updatedAt: new Date() })
          .where(and(eq(orders.id, shipment.orderId), inArray(orders.status, ['paid', 'processing'])));
      }
      const [order] = await tx.select().from(orders).where(eq(orders.id, shipment.orderId));
      return { updated, order };
    });
    if (outcome.order && (status === 'in_transit' || status === 'delivered')) {
      const customerStatus = status === 'in_transit' ? 'shipped' : 'delivered';
      await sendTransactionalEmail(orderStatusEmail(
        outcome.order.buyerEmail,
        outcome.order.orderNumber,
        customerStatus,
      ));
    }
    return outcome.updated;
  }

  static async createRfq(input: {
    requesterId?: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone?: string;
    items: Array<{ productId: string; quantity: number; size?: string; colour?: string }>;
    details?: string;
  }) {
    if (input.items.length === 0) throw new Error('At least one RFQ item is required');
    for (const item of input.items) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new Error('RFQ quantities must be positive integers');
      const [product] = await db.select().from(products).where(eq(products.id, item.productId));
      if (!product || product.status !== 'approved') throw new Error('RFQ item is not available');
      if (product.moq > 1 && item.quantity < product.moq) {
        throw new Error(`Quantity for ${product.name} must meet its wholesale MOQ of ${product.moq}`);
      }
    }
    const [request] = await db.insert(rfqRequests).values({
      ...input,
      requesterEmail: input.requesterEmail.trim().toLowerCase(),
      status: 'new',
    }).returning();

    // 1. Send confirmation email to the buyer (failures must never fail the request)
    try {
      await sendTransactionalEmail(rfqConfirmationEmail(
        request.requesterEmail,
        request.requesterName,
        request.id,
      ));
    } catch (error) {
      logger.error({ ...errorLogFields(error), rfqId: request.id }, 'Failed to send RFQ confirmation email to buyer');
    }

    // 2. Send alert email to ADMIN_NOTIFY_EMAIL if configured
    const adminNotifyEmail = process.env.ADMIN_NOTIFY_EMAIL?.trim();
    if (adminNotifyEmail) {
      try {
        await sendTransactionalEmail(rfqAdminAlertEmail(
          adminNotifyEmail,
          {
            id: request.id,
            requesterName: request.requesterName,
            requesterEmail: request.requesterEmail,
            itemCount: request.items.length,
          },
        ));
      } catch (error) {
        logger.error({ ...errorLogFields(error), rfqId: request.id }, 'Failed to send RFQ alert email to admin');
      }
    }

    return request;
  }

  static async listRfqs(status?: string) {
    return db.select().from(rfqRequests)
      .where(status ? eq(rfqRequests.status, status) : undefined);
  }

  static async getBuyerRfqs(userId: string) {
    if (!userId) return [];

    const [u] = await db.select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId));

    const normalizedEmail = (u?.email ?? '').trim().toLowerCase();

    // If verified, link any unattached RFQs matching this email
    if (u?.emailVerified && normalizedEmail) {
      await db.update(rfqRequests)
        .set({ requesterId: userId, updatedAt: new Date() })
        .where(and(
          isNull(rfqRequests.requesterId),
          sql`lower(trim(${rfqRequests.requesterEmail})) = ${normalizedEmail}`,
        ));
    }

    const rfqs = await db.select()
      .from(rfqRequests)
      .where(or(
        eq(rfqRequests.requesterId, userId),
        normalizedEmail ? sql`lower(trim(${rfqRequests.requesterEmail})) = ${normalizedEmail}` : sql`FALSE`,
      ))
      .orderBy(desc(rfqRequests.createdAt));

    if (rfqs.length === 0) return [];

    const productIds = rfqs.flatMap((r) => (r.items ?? []).map((i) => i.productId)).filter(Boolean);
    let productMap = new Map<string, { name: string; images: string[] }>();
    if (productIds.length > 0) {
      try {
        const prods = await db.select({ id: products.id, name: products.name, images: products.images })
          .from(products)
          .where(inArray(products.id, productIds));
        productMap = new Map(prods.map((p) => [p.id, { name: p.name, images: p.images ?? [] }]));
      } catch (e) {
        logger.warn({ ...errorLogFields(e) }, 'Failed to fetch product details for buyer RFQs');
      }
    }

    return rfqs.map((r) => ({
      ...r,
      items: (r.items ?? []).map((item) => {
        const p = productMap.get(item.productId);
        return {
          ...item,
          productName: p?.name ?? 'Custom Garment',
          productImage: Array.isArray(p?.images) && p.images.length > 0 ? p.images[0] : null,
        };
      }),
    }));
  }

  static async updateRfqByAdmin(
    rfqId: string,
    adminId: string,
    status: 'in_review' | 'quoted' | 'accepted' | 'declined' | 'closed',
    quoteAmountKobo?: number,
    quoteMessage?: string,
  ) {
    const [current] = await db.select().from(rfqRequests).where(eq(rfqRequests.id, rfqId));
    if (!current) throw new Error('RFQ not found');

    const allowed: Record<string, string[]> = {
      new: ['in_review', 'quoted', 'declined', 'closed'],
      in_review: ['quoted', 'declined', 'closed'],
      quoted: ['quoted', 'accepted', 'declined', 'closed'],
      accepted: ['closed'],
      declined: ['closed'],
      closed: [],
    };

    if (!allowed[current.status]?.includes(status)) {
      throw new Error(`Cannot transition RFQ from ${current.status} to ${status}`);
    }

    if (status === 'quoted') {
      if (typeof quoteAmountKobo !== 'number' || !Number.isSafeInteger(quoteAmountKobo) || quoteAmountKobo <= 0) {
        throw new Error('Quote amount must be a positive integer number of kobo');
      }
      if (!quoteMessage || !quoteMessage.trim()) {
        throw new Error('Quote message is required when quoting an RFQ');
      }
    }

    const [updated] = await db.update(rfqRequests)
      .set({
        status,
        ...(status === 'quoted' ? { quoteAmountKobo, quoteMessage: quoteMessage?.trim() ?? '' } : {}),
        reviewedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(rfqRequests.id, rfqId))
      .returning();

    let emailStatus: 'sent' | 'failed' | 'skipped' = 'skipped';
    let whatsappStatus: 'sent' | 'failed' | 'skipped' = 'skipped';

    if (status === 'quoted') {
      try {
        const productIds = (updated.items ?? []).map((i) => i.productId).filter(Boolean);
        let productMap = new Map<string, string>();
        if (productIds.length > 0) {
          try {
            const prods = await db.select({ id: products.id, name: products.name })
              .from(products)
              .where(inArray(products.id, productIds));
            productMap = new Map(prods.map((p) => [p.id, p.name]));
          } catch (e) {
            logger.warn({ ...errorLogFields(e) }, 'Failed to fetch product names for RFQ quote email');
          }
        }

        const emailItems = (updated.items ?? []).map((item) => ({
          name: productMap.get(item.productId) || (item as any).name || (item as any).productName || 'Requested Item',
          quantity: item.quantity,
          size: item.size,
          colour: item.colour,
        }));

        const result = await sendTransactionalEmail(rfqQuoteEmail(
          updated.requesterEmail,
          updated.requesterName,
          updated.id,
          updated.quoteAmountKobo!,
          updated.quoteMessage!,
          emailItems,
        ));
        emailStatus = result?.delivery === 'skipped' ? 'skipped' : 'sent';
      } catch (error) {
        logger.error({ ...errorLogFields(error), rfqId: updated.id }, 'Failed to send RFQ quote email to buyer');
        emailStatus = 'failed';
      }

      if (updated.requesterPhone) {
        try {
          const shortId = updated.id.slice(0, 8).toUpperCase();
          const naira = (updated.quoteAmountKobo! / 100).toLocaleString('en-NG', {
            minimumFractionDigits: updated.quoteAmountKobo! % 100 === 0 ? 0 : 2,
            maximumFractionDigits: 2,
          });
          whatsappStatus = await sendWhatsAppMessage(
            updated.requesterPhone,
            `Hello ${updated.requesterName}, your Copeland quote #${shortId} is ready. Total: â‚¦${naira}. Please check your email for full details.`,
          );
        } catch (error) {
          logger.warn({ ...errorLogFields(error), rfqId: updated.id }, 'Failed to send WhatsApp RFQ notification');
          whatsappStatus = 'skipped';
        }
      }
    }

    return {
      ...updated,
      notification: {
        email: emailStatus,
        whatsapp: whatsappStatus,
      },
    };
  }

  static async respondToRfq(rfqId: string, email: string, accepted: boolean) {
    const expectedStatus = accepted ? 'accepted' : 'declined';
    const [updated] = await db.update(rfqRequests)
      .set({ status: expectedStatus, updatedAt: new Date() })
      .where(and(
        eq(rfqRequests.id, rfqId),
        eq(rfqRequests.requesterEmail, email.trim().toLowerCase()),
        eq(rfqRequests.status, 'quoted'),
      ))
      .returning();
    if (!updated) throw new Error('Quoted RFQ not found for this email');
    return updated;
  }
}
