import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';
import { partners } from './partners.js';
import { orders, orderItems } from './orders.js';
import { user } from './auth.js';

export const payouts = pgTable('payouts', {
  id: uuid('id').defaultRandom().primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  amountKobo: integer('amount_kobo').notNull(),
  status: text('status').default('pending').notNull(),
  reference: uuid('reference').defaultRandom().notNull().unique(),
  paystackTransferCode: text('paystack_transfer_code'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const payments = pgTable('payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  reference: text('reference').notNull().unique(),
  amountKobo: integer('amount_kobo').notNull(),
  status: text('status').default('initialized').notNull(),
  providerPayload: jsonb('provider_payload'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  provider: text('provider').notNull(),
  eventKey: text('event_key').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('webhook_events_provider_key_unique').on(table.provider, table.eventKey),
]);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorId: text('actor_id').references(() => user.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const payoutItems = pgTable('payout_items', {
  orderItemId: uuid('order_item_id').primaryKey().references(() => orderItems.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  amountKobo: integer('amount_kobo').notNull(),
  status: text('status').default('pending').notNull(),
  reference: uuid('reference').defaultRandom().notNull().unique(),
  paystackTransferCode: text('paystack_transfer_code'),
  manualReference: text('manual_reference'),
  payoutMode: text('payout_mode').default('paystack').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').references(() => orders.id),
  orderItemId: uuid('order_item_id').references(() => orderItems.id),
  payoutItemId: uuid('payout_item_id').references(() => payoutItems.orderItemId),
  partnerId: uuid('partner_id').references(() => partners.id),
  entryType: text('entry_type', {
    enum: ['item_sale', 'commission', 'payout_sent', 'payout_reversed', 'refund_clawback', 'adjustment'],
  }).notNull(),
  amountKobo: integer('amount_kobo').notNull(),
  description: text('description').notNull(),
  adjustmentNote: text('adjustment_note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('ledger_item_sale_once').on(table.orderItemId).where(sql`${table.entryType} = 'item_sale'`),
  uniqueIndex('ledger_commission_once').on(table.orderItemId).where(sql`${table.entryType} = 'commission'`),
  uniqueIndex('ledger_payout_sent_once').on(table.payoutItemId).where(sql`${table.entryType} = 'payout_sent'`),
  uniqueIndex('ledger_payout_reversed_once').on(table.payoutItemId).where(sql`${table.entryType} = 'payout_reversed'`),
]);
