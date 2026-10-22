import { db } from '../db/index.js';
import { orders, orderItems, products, partners, payments, productInventory } from '../db/schema/index.js';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { calculateCommissionKobo, getCommissionRateBps } from './money.js';

export class OrderService {
  static async createCheckout(
    email: string,
    items: { productId: string, quantity: number, size?: string, colour?: string }[],
    buyer?: { name?: string; phone?: string },
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
        buyerName: buyer?.name,
        buyerEmail: email.trim().toLowerCase(),
        buyerPhone: buyer?.phone,
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

  static async lookupGuestOrder(orderNumber: string, email: string) {
    const [order] = await db.select().from(orders).where(and(
      eq(orders.orderNumber, orderNumber.trim()),
      eq(orders.buyerEmail, email.trim().toLowerCase()),
    ));
    if (!order) return null;
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    return { order, items };
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
        callback_url: 'http://localhost:5173/payment-success', // Your future frontend URL
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
}
