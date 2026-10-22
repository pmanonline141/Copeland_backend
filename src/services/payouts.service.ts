import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, ledgerEntries, orderItems, orders, partners, payoutItems, products } from '../db/schema/index.js';
import { sendTransactionalEmail } from './notifications.service.js';
import { payoutSentEmail } from './email-templates.js';

const PAYOUT_REVIEW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export class PayoutService {
  private static formatPaystackTransferError(paystackData: { message?: unknown }) {
    const message = typeof paystackData?.message === 'string' ? paystackData.message : 'Paystack transfer failed';

    if (/starter business|third party payouts/i.test(message)) {
      return 'Your Paystack account is on the Starter plan, which does not allow third-party payouts. Use manual payout mode or upgrade the Paystack business account.';
    }

    return message;
  }

  static async approveOrderItemPayout(orderItemId: string, actorId: string) {
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, orderItemId));
    if (!item) throw new Error('Order item not found');
    if (item.fulfillmentStatus !== 'delivered' || !item.payoutEligibleAt) {
      throw new Error('Payout is available only after the item is delivered');
    }
    if (item.payoutEligibleAt.getTime() > Date.now()) {
      throw new Error('Payout review window has not elapsed');
    }

    const [order] = await db.select().from(orders).where(eq(orders.id, item.orderId));
    if (!order || order.status !== 'paid') throw new Error('Order must be paid before payout');
    const [product] = await db.select().from(products).where(eq(products.id, item.productId));
    if (!product) throw new Error('Product not found');
    const [partner] = await db.select().from(partners).where(eq(partners.id, product.partnerId));
    if (!partner || partner.status !== 'approved') throw new Error('Supplier must be approved before payout');

    const amountKobo = item.priceKoboAtPurchase * item.quantity - item.commissionAmountKobo;
    if (!Number.isSafeInteger(amountKobo) || amountKobo < 0) throw new Error('Invalid payout amount');

    const [existing] = await db.select().from(payoutItems).where(eq(payoutItems.orderItemId, item.id));
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'failed') {
        const [approved] = await db.update(payoutItems)
          .set({ status: 'approved', updatedAt: new Date() })
          .where(and(eq(payoutItems.orderItemId, item.id), eq(payoutItems.status, existing.status)))
          .returning();
        if (approved) {
          await db.insert(auditLog).values({
            actorId,
            action: 'payout.approved',
            entityType: 'payout_item',
            entityId: item.id,
            details: { amountKobo: approved.amountKobo },
          });
        }
        return approved ?? existing;
      }
      return existing;
    }

    const [created] = await db.insert(payoutItems).values({
      orderItemId: item.id,
      partnerId: partner.id,
      amountKobo,
      status: 'approved',
    }).onConflictDoNothing().returning();

    if (created) {
      await db.insert(auditLog).values({
        actorId,
        action: 'payout.approved',
        entityType: 'payout_item',
        entityId: item.id,
        details: { amountKobo: created.amountKobo },
      });
      return created;
    }
    const [concurrent] = await db.select().from(payoutItems).where(eq(payoutItems.orderItemId, item.id));
    if (!concurrent) throw new Error('Payout item could not be created');
    return concurrent;
  }

  static async initiateSupplierPayout(orderId: string, actorId: string) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order || order.status !== 'paid') throw new Error('Order not found or not paid');
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const results = [];

    for (const item of items) {
      const [payoutItem] = await db.select().from(payoutItems)
        .where(eq(payoutItems.orderItemId, item.id));
      if (!payoutItem || !['approved', 'failed'].includes(payoutItem.status)) continue;

      const [claimed] = await db.update(payoutItems)
        .set({ status: 'initiated', updatedAt: new Date() })
        .where(and(
          eq(payoutItems.orderItemId, item.id),
          inArray(payoutItems.status, ['approved', 'failed']),
        ))
        .returning();
      if (!claimed) continue;
      await db.insert(auditLog).values({
        actorId,
        action: 'payout.initiated',
        entityType: 'payout_item',
        entityId: item.id,
        details: { reference: claimed.reference, amountKobo: claimed.amountKobo },
      });

      const [partner] = await db.select().from(partners).where(eq(partners.id, claimed.partnerId));
      if (!partner || partner.status !== 'approved') {
        await db.update(payoutItems)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(payoutItems.orderItemId, item.id));
        throw new Error('Supplier must be approved before payout');
      }
      if (!partner.paystackRecipientCode) {
        await db.update(payoutItems)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(payoutItems.orderItemId, item.id));
        throw new Error('Supplier does not have a Paystack recipient code');
      }

      try {
        const response = await fetch('https://api.paystack.co/transfer', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            source: 'balance',
            amount: claimed.amountKobo,
            recipient: partner.paystackRecipientCode,
            reason: `Payout for order item ${item.id}`,
            reference: claimed.reference,
          }),
        });

        const paystackData = await response.json() as {
          status?: boolean;
          message?: unknown;
          data?: { transfer_code?: string };
        };
        if (!response.ok || !paystackData.status) {
          throw new Error(this.formatPaystackTransferError(paystackData));
        }

        const [updated] = await db.update(payoutItems)
          .set({
            paystackTransferCode: paystackData.data?.transfer_code ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(payoutItems.orderItemId, item.id), eq(payoutItems.status, 'initiated')))
          .returning();
        results.push(updated);
      } catch (error) {
        await db.update(payoutItems)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(and(eq(payoutItems.orderItemId, item.id), eq(payoutItems.status, 'initiated')));
        throw error;
      }
    }

    return { payouts: results };
  }

  static async recordManualPayout(orderItemId: string, manualReference: string, actorId: string) {
    const reference = manualReference.trim();
    if (!reference) throw new Error('A bank-transfer reference is required');

    const updated = await db.transaction(async (tx) => {
      const [payoutItem] = await tx.select().from(payoutItems)
        .where(eq(payoutItems.orderItemId, orderItemId));
      if (!payoutItem || payoutItem.status !== 'approved') {
        throw new Error('Only an approved payout can be recorded manually');
      }

      const [updated] = await tx.update(payoutItems)
        .set({
          status: 'success',
          payoutMode: 'manual',
          manualReference: reference,
          updatedAt: new Date(),
        })
        .where(and(eq(payoutItems.orderItemId, orderItemId), eq(payoutItems.status, 'approved')))
        .returning();
      if (!updated) throw new Error('Payout was already processed');

      const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, orderItemId));
      if (!item) throw new Error('Order item not found after payout');

      await tx.insert(ledgerEntries).values({
        orderId: item.orderId,
        orderItemId,
        payoutItemId: orderItemId,
        partnerId: updated.partnerId,
        entryType: 'payout_sent',
        amountKobo: -updated.amountKobo,
        description: `Manual bank payout. Reference: ${reference}`,
      });
      await tx.insert(auditLog).values({
        actorId,
        action: 'payout.manual_sent',
        entityType: 'payout_item',
        entityId: orderItemId,
        details: { reference, amountKobo: updated.amountKobo },
      });
      const orderItemsForOrder = await tx.select({ id: orderItems.id })
        .from(orderItems).where(eq(orderItems.orderId, item.orderId));
      const payoutRows = await tx.select().from(payoutItems)
        .where(inArray(payoutItems.orderItemId, orderItemsForOrder.map((row) => row.id)));
      if (orderItemsForOrder.length > 0
        && payoutRows.length === orderItemsForOrder.length
        && payoutRows.every((row) => row.status === 'success')) {
        await tx.update(orders).set({ status: 'completed', updatedAt: new Date() })
          .where(eq(orders.id, item.orderId));
      }
      return updated;
    });
    const [partner] = await db.select({ contactEmail: partners.contactEmail })
      .from(partners).where(eq(partners.id, updated.partnerId));
    if (partner?.contactEmail) {
      await sendTransactionalEmail(payoutSentEmail(
        partner.contactEmail,
        updated.amountKobo,
        reference,
      ));
    }
    return updated;
  }

  static payoutEligibleAt(deliveredAt: Date) {
    return new Date(deliveredAt.getTime() + PAYOUT_REVIEW_DAYS * DAY_MS);
  }
}
