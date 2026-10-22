import { pgTable, uuid, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { partners } from './partners.js';
import { orders } from './orders.js';
import { user } from './auth.js';

export type RfqItem = {
  productId: string;
  quantity: number;
  size?: string;
  colour?: string;
};

export const rfqRequests = pgTable('rfq_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  requesterId: text('requester_id').references(() => user.id),
  requesterName: text('requester_name').notNull(),
  requesterEmail: text('requester_email').notNull(),
  requesterPhone: text('requester_phone'),
  items: jsonb('items').$type<RfqItem[]>().notNull(),
  details: text('details'),
  status: text('status').default('new').notNull(),
  quoteAmountKobo: integer('quote_amount_kobo'),
  quoteMessage: text('quote_message'),
  reviewedBy: text('reviewed_by').references(() => user.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const shipments = pgTable('shipments', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  shippingPartnerId: uuid('shipping_partner_id').notNull().references(() => partners.id),
  trackingNumber: text('tracking_number').notNull().unique(),
  status: text('status').default('created').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const shipmentUpdates = pgTable('shipment_updates', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id),
  status: text('status').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
