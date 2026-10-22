import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { partners } from './partners.js';
import { user } from './auth.js';
export const products = pgTable('products', {
    id: uuid('id').defaultRandom().primaryKey(),
    partnerId: uuid('partner_id').notNull().references(() => partners.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    priceKobo: integer('price_kobo').notNull(),
    moq: integer('moq').default(1).notNull(),
    quantityAvailable: integer('quantity_available').default(0).notNull(),
    colours: jsonb('colours').$type().default([]).notNull(),
    sizes: jsonb('sizes').$type().default([]).notNull(),
    images: jsonb('images').$type().default([]).notNull(),
    tier: text('tier').default('standard').notNull(),
    status: text('status').default('draft').notNull(),
    isCopelandLabel: boolean('is_copeland_label').default(false).notNull(),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
export const productInventory = pgTable('product_inventory', {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id').notNull().references(() => products.id),
    size: text('size').notNull().default(''),
    colour: text('colour').notNull().default(''),
    quantityAvailable: integer('quantity_available').default(0).notNull(),
}, (table) => [
    uniqueIndex('product_inventory_variant_unique').on(table.productId, table.size, table.colour),
]);
export const moderationRecords = pgTable('moderation_records', {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id').notNull().references(() => products.id),
    moderatorId: text('moderator_id').notNull().references(() => user.id),
    decision: text('decision').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});
