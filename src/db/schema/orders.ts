import { pgTable, uuid, text, integer, timestamp, boolean, unique } from 'drizzle-orm/pg-core';
import { products } from './products.js';
import { partners } from './partners.js';

export const orders = pgTable('orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  buyerId: text('buyer_id'),
  buyerName: text('buyer_name'),
  buyerEmail: text('buyer_email').notNull(),
  buyerPhone: text('buyer_phone'),
  orderNumber: text('order_number').notNull(),
  totalAmountKobo: integer('total_amount_kobo').notNull(),
  status: text('status').default('pending_payment').notNull(),
  currency: text('currency').default('NGN').notNull(),
  requiresAdminReview: boolean('requires_admin_review').default(false).notNull(),
  adminReviewReason: text('admin_review_reason'),
  shippingPartnerId: uuid('shipping_partner_id').references(() => partners.id),
  paystackReference: text('paystack_reference').unique(),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [unique('orders_order_number_unique').on(table.orderNumber)]);

export const orderItems = pgTable('order_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: integer('quantity').notNull(),
  priceKoboAtPurchase: integer('price_kobo_at_purchase').notNull(),
  commissionRateBps: integer('commission_rate_bps').default(1000).notNull(),
  commissionAmountKobo: integer('commission_amount_kobo').default(0).notNull(),
  size: text('size'),
  colour: text('colour'),
  fulfillmentStatus: text('fulfillment_status').default('pending').notNull(),
  deliveredAt: timestamp('delivered_at'),
  payoutEligibleAt: timestamp('payout_eligible_at'),
});
