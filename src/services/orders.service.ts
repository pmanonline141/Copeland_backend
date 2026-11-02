import { db } from '../db/index.js';
import { orders, orderItems, products, partners, payments, productInventory, ledgerEntries, payoutItems, shipments, shipmentUpdates } from '../db/schema/index.js';
import { user } from '../db/schema/auth.js';
import { and, eq, gte, lte, sql, desc, inArray, isNull } from 'drizzle-orm';
import crypto from 'crypto';
import { calculateCommissionKobo, getCommissionRateBps } from './money.js';
import { sendTransactionalEmail } from './notifications.service.js';
import { orderConfirmationEmail } from './email-templates.js';
import { logger } from '../logger.js';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface LinkableOrder {
  id: string;
  buyerId: string | null;
  buyerEmail: string;
}

export interface LinkableUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Pure evaluation function for guest order linking.
 * Validates verification status, normalized email match, and unattached state (buyerId is null).
 */
export function determineOrdersToLink(
  targetUser: LinkableUser,
  candidateOrders: LinkableOrder[]
): { eligible: LinkableOrder[]; ineligibleReason?: string } {
  if (!targetUser.emailVerified) {
    return { eligible: [], ineligibleReason: 'EMAIL_NOT_VERIFIED' };
  }

  const normalizedUserEmail = normalizeEmail(targetUser.email);

  const eligible = candidateOrders.filter((candidate) => {
    // Must not already be linked to an account
    if (candidate.buyerId !== null) return false;
    // Must match the normalized email
    return normalizeEmail(candidate.buyerEmail) === normalizedUserEmail;
  });

  return { eligible };
}

export class OrderService {
  static async createCheckout(
    email: string,
    items: { productId: string, quantity: number, size?: string, colour?: string }[],
    buyer?: {
      name?: string;
      phone?: string;
      buyerId?: string;
      address?: string;
      city?: string;
      state?: string;
      landmark?: string;
      notes?: string;
    },
  ) {
    if (items.length === 0) throw new Error('At least one item is required');

    return db.transaction(async (tx) => {
      let totalAmountKobo = 0;
      const itemsToInsert = [];

      for (const item of items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
          throw new Error('Item quantity must be a positive integer');
        }
        await tx.execute(sql`SELECT id FROM products WHERE id = ${item.productId} FOR UPDATE`);
        const [product] = await tx.select().from(products).where(eq(products.id, item.productId));
        if (!product || product.status !== 'approved') throw new Error('Product not available');
        if (product.moq > 1 && item.quantity >= product.moq) {
          throw new Error('Wholesale quantities must be submitted through the RFQ flow');
        }

        const itemTotalKobo = product.priceKobo * item.quantity;
        if (!Number.isSafeInteger(itemTotalKobo)) throw new Error('Order item amount exceeds the supported range');
        const [partner] = await tx.select().from(partners).where(eq(partners.id, product.partnerId));
        if (!partner || partner.status !== 'approved') throw new Error('Supplier is not available');
        const commissionRateBps = getCommissionRateBps(partner.commissionRateBps);
        const commissionAmountKobo = calculateCommissionKobo(itemTotalKobo, commissionRateBps);

        totalAmountKobo += itemTotalKobo;
        if (!Number.isSafeInteger(totalAmountKobo) || totalAmountKobo > 2_147_483_647) {
          throw new Error('Order amount exceeds the supported range');
        }

        const variantSize = item.size ?? '';
        const variantColour = item.colour ?? '';
        const variants = await tx.select({ id: productInventory.id })
          .from(productInventory)
          .where(eq(productInventory.productId, product.id));

        if (variants.length > 0) {
          await tx.execute(sql`
            SELECT id FROM product_inventory
            WHERE product_id = ${product.id}
              AND size = ${variantSize}
              AND colour = ${variantColour}
            FOR UPDATE
          `);
          const [variant] = await tx.select().from(productInventory).where(and(
            eq(productInventory.productId, product.id),
            eq(productInventory.size, variantSize),
            eq(productInventory.colour, variantColour),
            gte(productInventory.quantityAvailable, item.quantity),
          ));
          if (!variant) throw new Error('Selected size and colour are unavailable');
          await tx.update(productInventory)
            .set({ quantityAvailable: sql`${productInventory.quantityAvailable} - ${item.quantity}` })
            .where(eq(productInventory.id, variant.id));
          const [reservedProduct] = await tx.update(products)
            .set({ quantityAvailable: sql`${products.quantityAvailable} - ${item.quantity}` })
            .where(and(eq(products.id, product.id), gte(products.quantityAvailable, item.quantity)))
            .returning({ id: products.id });
          if (!reservedProduct) throw new Error('Not enough stock');
        } else {
          const [reservedProduct] = await tx.update(products)
            .set({ quantityAvailable: sql`${products.quantityAvailable} - ${item.quantity}` })
            .where(and(eq(products.id, product.id), gte(products.quantityAvailable, item.quantity)))
            .returning({ id: products.id });
          if (!reservedProduct) throw new Error('Not enough stock');
        }

        itemsToInsert.push({
          productId: product.id,
          quantity: item.quantity,
          priceKoboAtPurchase: product.priceKobo,
          commissionRateBps,
          commissionAmountKobo,
          size: item.size,
          colour: item.colour
        });
      }

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const orderNumber = `COP-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
      const reference = 'ord_' + crypto.randomUUID();
      const [order] = await tx.insert(orders).values({
        buyerId: buyer?.buyerId ?? null,
        buyerName: buyer?.name,
        buyerEmail: normalizeEmail(email),
        buyerPhone: buyer?.phone,
        shippingAddress: (buyer?.address || buyer?.city || buyer?.state)
          ? {
              addressLine1: buyer?.address,
              city: buyer?.city,
              state: buyer?.state,
              landmark: buyer?.landmark,
              notes: buyer?.notes,
            }
          : undefined,
        orderNumber,
        totalAmountKobo,
        status: 'pending_payment',
        expiresAt,
        paystackReference: reference
      }).returning();

      const insertedItems = await tx.insert(orderItems).values(itemsToInsert.map((item) => ({
        orderId: order.id,
        ...item,
      }))).returning();

      return { order, items: insertedItems };
    });
  }

  static async cancelPendingOrder(orderId: string, buyerEmail?: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      if (!order || order.status !== 'pending_payment') return false;
      if (buyerEmail && order.buyerEmail !== buyerEmail.trim().toLowerCase()) return false;

      await tx.update(orders)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')));
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      for (const item of items) {
        const variants = await tx.select({ id: productInventory.id })
          .from(productInventory)
          .where(eq(productInventory.productId, item.productId));
        const [variant] = variants.length > 0
          ? await tx.select().from(productInventory).where(and(
            eq(productInventory.productId, item.productId),
            eq(productInventory.size, item.size ?? ''),
            eq(productInventory.colour, item.colour ?? ''),
          ))
          : [];
        if (variant) {
          await tx.update(productInventory)
            .set({ quantityAvailable: sql`${productInventory.quantityAvailable} + ${item.quantity}` })
            .where(eq(productInventory.id, variant.id));
        }
        await tx.update(products)
          .set({ quantityAvailable: sql`${products.quantityAvailable} + ${item.quantity}` })
          .where(eq(products.id, item.productId));
      }
      return true;
    });
  }

  static async expireUnpaidOrders() {
    const expired = await db.select({ id: orders.id }).from(orders).where(and(
      eq(orders.status, 'pending_payment'),
      lte(orders.expiresAt, new Date()),
    ));
    let cancelledCount = 0;
    for (const order of expired) {
      if (await this.cancelPendingOrder(order.id)) cancelledCount += 1;
    }
    return cancelledCount;
  }

 // Replace the existing `static async lookupGuestOrder(...)` in src/services/orders.service.ts with this.
// Needs `shipments` and `shipmentUpdates` (already imported) and `sql`, `desc`, `inArray` (already imported).
  /**
   * Guest lookup by order number OR shipment tracking number, plus buyer email.
   * Returns a flat order with product names/images, shipments and their update history.
   */
  static async lookupGuestOrder(reference: string, email: string) {
    const ref = reference.trim();
    const mail = normalizeEmail(email);
    if (!ref || !mail) return null;

    // 1) by order number (case-insensitive)
    let [order] = await db.select().from(orders).where(and(
      sql`upper(${orders.orderNumber}) = ${ref.toUpperCase()}`,
      sql`lower(trim(${orders.buyerEmail})) = ${mail}`,
    ));

    // 2) by tracking number
    if (!order) {
      const [ship] = await db.select().from(shipments)
        .where(sql`lower(trim(${shipments.trackingNumber})) = ${ref.toLowerCase()}`);
      if (ship) {
        [order] = await db.select().from(orders).where(and(
          eq(orders.id, ship.orderId),
          sql`lower(trim(${orders.buyerEmail})) = ${mail}`,
        ));
      }
    }
    if (!order) return null;

    const itemRows = await db.select({
      id: orderItems.id,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      priceKoboAtPurchase: orderItems.priceKoboAtPurchase,
      size: orderItems.size,
      colour: orderItems.colour,
      fulfillmentStatus: orderItems.fulfillmentStatus,
      productName: products.name,
      productImages: products.images,
    }).from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(eq(orderItems.orderId, order.id));

    const items = itemRows.map(({ productImages, ...it }) => ({
      ...it,
      productImage: Array.isArray(productImages) && productImages.length > 0 ? productImages[0] : null,
    }));

    const shipmentRows = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
    const updateRows = shipmentRows.length > 0
      ? await db.select().from(shipmentUpdates)
          .where(inArray(shipmentUpdates.shipmentId, shipmentRows.map((s) => s.id)))
          .orderBy(desc(shipmentUpdates.createdAt))
      : [];

    return {
      ...order,
      totalKobo: order.totalAmountKobo,
      items,
      shipments: shipmentRows.map((s) => ({ ...s, updates: updateRows.filter((u) => u.shipmentId === s.id) })),
    };
  }

  // NEW: Initialize Paystack Payment
  static async initializePayment(orderId: string) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) throw new Error('Order not found');
    if (order.status !== 'pending_payment') throw new Error('Order is not pending');
    if (order.expiresAt && order.expiresAt.getTime() <= Date.now()) {
      await this.cancelPendingOrder(order.id);
      throw new Error('Order payment window has expired');
    }

    const reference = 'pay_' + crypto.randomUUID();
    const [payment] = await db.insert(payments).values({
      orderId: order.id,
      reference,
      amountKobo: order.totalAmountKobo,
      status: 'initializing',
    }).returning();

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: order.buyerEmail,
        amount: order.totalAmountKobo,
        reference,
        callback_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/success`,
      }),
    });

    const data = await response.json() as {
      status?: boolean;
      message?: string;
      data?: { authorization_url: string; reference: string };
    };
    if (!response.ok || !data.status || !data.data) {
      await db.update(payments)
        .set({ status: 'failed', providerPayload: data, updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      throw new Error(data.message ?? 'Paystack payment initialization failed');
    }

    await db.update(payments)
      .set({ status: 'pending', providerPayload: data, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

    return {
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    };
  }

  static async verifyAndConfirmPayment(reference: string) {
    const [payment] = await db.select().from(payments).where(eq(payments.reference, reference));
    if (!payment) throw new Error('Payment reference not found');

    const [order] = await db.select().from(orders).where(eq(orders.id, payment.orderId));
    if (!order) throw new Error('Order not found');

    if (order.status === 'paid') {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      return { order, items, paid: true, alreadyPaid: true };
    }

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const result = await response.json() as {
      status?: boolean;
      message?: string;
      data?: { status?: string; reference?: string; amount?: number; currency?: string };
    };

    if (!response.ok || !result.status || result.data?.reference !== reference) {
      throw new Error(result.message ?? 'Paystack could not verify this transaction');
    }

    if (result.data.status !== 'success') {
      return { order, status: result.data.status, paid: false };
    }

    let queuedEmail: { to: string; subject: string; html: string } | undefined;
    const finalOrder = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
      const [currentOrder] = await tx.select().from(orders).where(eq(orders.id, order.id));
      if (!currentOrder) throw new Error('Order not found');

      if (currentOrder.status === 'paid') return currentOrder;

      const verifiedData = result.data!;
      const amountMatches = Number.isSafeInteger(verifiedData.amount)
        && verifiedData.amount === currentOrder.totalAmountKobo
        && payment.amountKobo === currentOrder.totalAmountKobo;
      const currencyMatches = verifiedData.currency === currentOrder.currency;

      if (!amountMatches || !currencyMatches || currentOrder.status !== 'pending_payment') {
        const reason = currentOrder.status !== 'pending_payment'
          ? `Payment success received for an order in ${currentOrder.status} state`
          : 'Verified payment amount or currency does not match the order';
        await tx.update(orders).set({
          requiresAdminReview: true,
          adminReviewReason: reason,
          updatedAt: new Date(),
        }).where(eq(orders.id, currentOrder.id));
        await tx.update(payments).set({
          status: 'requires_review',
          providerPayload: result,
          updatedAt: new Date(),
        }).where(eq(payments.id, payment.id));
        throw new Error('Payment mismatch: requires review');
      }

      await tx.update(orders).set({ status: 'paid', updatedAt: new Date() }).where(eq(orders.id, currentOrder.id));
      await tx.update(payments).set({
        status: 'success',
        providerPayload: result,
        updatedAt: new Date(),
      }).where(eq(payments.id, payment.id));

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, currentOrder.id));
      const productNames: string[] = [];
      for (const item of items) {
        const [product] = await tx.select().from(products).where(eq(products.id, item.productId));
        if (!product) continue;
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
            orderId: currentOrder.id,
            orderItemId: item.id,
            partnerId: product.partnerId,
            entryType: 'item_sale',
            amountKobo: grossKobo,
            description: `Sale recorded for order item ${item.id}`,
          },
          {
            orderId: currentOrder.id,
            orderItemId: item.id,
            partnerId: product.partnerId,
            entryType: 'commission',
            amountKobo: -item.commissionAmountKobo,
            description: `Commission at ${item.commissionRateBps} basis points`,
          },
        ]).onConflictDoNothing();
      }

      queuedEmail = {
        ...orderConfirmationEmail(currentOrder.buyerEmail, currentOrder.orderNumber, productNames),
      };

      return currentOrder;
    });

    if (queuedEmail) {
      sendTransactionalEmail(queuedEmail).catch(() => {});
    }

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, finalOrder.id));
    return { order: finalOrder, items, paid: true };
  }

  /**
   * Links unattached guest orders to a verified user account matching their email.
   * Guarded against misattribution: only links if user email is verified.
   * Idempotent: orders already attached (buyerId != null) will not be re-linked.
   */
  static async linkGuestOrdersToUser(userId: string, userEmail?: string): Promise<{ linkedCount: number; orderIds: string[] }> {
    if (!userId) return { linkedCount: 0, orderIds: [] };

    // Fetch user to verify emailVerified status and email
    const [userRecord] = await db.select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
    }).from(user).where(eq(user.id, userId));

    if (!userRecord) {
      logger.warn({ userId }, 'Cannot link guest orders: user not found');
      return { linkedCount: 0, orderIds: [] };
    }

    // Security guard against misattribution: only link orders when email is verified
    if (!userRecord.emailVerified) {
      logger.info({ userId, email: userRecord.email }, 'Skipping guest order linking: email is not verified');
      return { linkedCount: 0, orderIds: [] };
    }

    const normalizedEmail = normalizeEmail(userEmail || userRecord.email);

    // Find all unattached guest orders matching this normalized email
    const matchingOrders = await db.select({ id: orders.id })
      .from(orders)
      .where(and(
        isNull(orders.buyerId),
        sql`lower(trim(${orders.buyerEmail})) = ${normalizedEmail}`,
      ));

    if (matchingOrders.length === 0) {
      return { linkedCount: 0, orderIds: [] };
    }

    const orderIds = matchingOrders.map((o) => o.id);

    // Atomically attach the orders to this user
    await db.update(orders)
      .set({
        buyerId: userRecord.id,
        updatedAt: new Date(),
      })
      .where(and(
        isNull(orders.buyerId),
        inArray(orders.id, orderIds),
      ));

    logger.info({
      userId: userRecord.id,
      email: normalizedEmail,
      linkedCount: orderIds.length,
      orderIds,
    }, 'Successfully linked guest orders to registered user account');

    return { linkedCount: orderIds.length, orderIds };
  }

  /**
   * Returns all orders for a buyer account, including linked guest orders and direct orders.
   * Automatically executes guest order linking first to ensure up-to-date history.
   */
  static async getBuyerOrders(userId: string) {
    if (!userId) return [];

    // Automatically link any new or unattached guest orders matching the user's verified email
    await this.linkGuestOrdersToUser(userId);

    const buyerOrders = await db.select()
      .from(orders)
      .where(eq(orders.buyerId, userId))
      .orderBy(desc(orders.createdAt));

    if (buyerOrders.length === 0) return [];

    const orderIds = buyerOrders.map((o) => o.id);
    const items = await db.select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      priceKoboAtPurchase: orderItems.priceKoboAtPurchase,
      size: orderItems.size,
      colour: orderItems.colour,
      fulfillmentStatus: orderItems.fulfillmentStatus,
      productName: products.name,
      productImages: products.images,
    })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIds));

    const mappedItems = items.map((item) => ({
      id: item.id,
      orderId: item.orderId,
      productId: item.productId,
      quantity: item.quantity,
      priceKoboAtPurchase: item.priceKoboAtPurchase,
      size: item.size,
      colour: item.colour,
      fulfillmentStatus: item.fulfillmentStatus,
      productName: item.productName,
      productImage: Array.isArray(item.productImages) && item.productImages.length > 0 ? item.productImages[0] : null,
    }));

    // Also fetch payment info for these orders
    const paymentRows = orderIds.length > 0
      ? await db.select({
          orderId: payments.orderId,
          reference: payments.reference,
          status: payments.status,
          amountKobo: payments.amountKobo,
          createdAt: payments.createdAt,
        })
          .from(payments)
          .where(inArray(payments.orderId, orderIds))
      : [];

    const itemsByOrder = new Map<string, typeof mappedItems>();
    for (const item of mappedItems) {
      const list = itemsByOrder.get(item.orderId) || [];
      list.push(item);
      itemsByOrder.set(item.orderId, list);
    }

    const paymentsByOrder = new Map<string, (typeof paymentRows)[0]>();
    for (const payment of paymentRows) {
      if (!paymentsByOrder.has(payment.orderId) || payment.status === 'success') {
        paymentsByOrder.set(payment.orderId, payment);
      }
    }

    // Delivery tracking: shipments and their status history for these orders.
    const shipmentRows = await db.select().from(shipments)
      .where(inArray(shipments.orderId, orderIds));
    const shipmentIds = shipmentRows.map((s) => s.id);
    const shipmentUpdateRows = shipmentIds.length > 0
      ? await db.select().from(shipmentUpdates)
          .where(inArray(shipmentUpdates.shipmentId, shipmentIds))
          .orderBy(desc(shipmentUpdates.createdAt))
      : [];

    return buyerOrders.map((order) => ({
      ...order,
      totalKobo: order.totalAmountKobo,
      items: itemsByOrder.get(order.id) || [],
      payment: paymentsByOrder.get(order.id) || null,
      shipments: shipmentRows
        .filter((s) => s.orderId === order.id)
        .map((s) => ({ ...s, updates: shipmentUpdateRows.filter((u) => u.shipmentId === s.id) })),
    }));
  }
}
