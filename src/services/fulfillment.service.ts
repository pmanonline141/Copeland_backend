import { and, eq, sql } from 'drizzle-orm';
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
import { PayoutService } from './payouts.service.js';
import { sendTransactionalEmail } from './notifications.service.js';
import { orderStatusEmail } from './email-templates.js';

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
    return request;
  }

  static async listRfqs(status?: string) {
    return db.select().from(rfqRequests)
      .where(status ? eq(rfqRequests.status, status) : undefined);
  }

  static async updateRfqByAdmin(
    rfqId: string,
    adminId: string,
    status: 'in_review' | 'quoted' | 'declined' | 'closed',
    quoteAmountKobo?: number,
    quoteMessage?: string,
  ) {
    const [current] = await db.select().from(rfqRequests).where(eq(rfqRequests.id, rfqId));
    if (!current) throw new Error('RFQ not found');
    const allowed: Record<string, string[]> = {
      new: ['in_review'],
      in_review: ['quoted', 'declined'],
      accepted: ['closed'],
      declined: ['closed'],
    };
    if (!allowed[current.status]?.includes(status)) {
      throw new Error(`Cannot transition RFQ from ${current.status} to ${status}`);
    }
    if (status === 'quoted' && (!Number.isSafeInteger(quoteAmountKobo) || quoteAmountKobo! < 0)) {
      throw new Error('Quote amount must be a non-negative integer number of kobo');
    }
    const [updated] = await db.update(rfqRequests)
      .set({
        status,
        ...(status === 'quoted' ? { quoteAmountKobo, quoteMessage: quoteMessage?.trim() ?? null } : {}),
        reviewedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(rfqRequests.id, rfqId))
      .returning();
    return updated;
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
