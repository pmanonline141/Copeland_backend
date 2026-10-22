import { pgTable, uuid, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const partners = pgTable('partners', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => user.id).unique(),
  businessName: text('business_name').notNull(),
  companyName: text('company_name'),
  cacNumber: text('cac_number'),
  tin: text('tin'),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  address: text('address'),
  capabilities: jsonb('capabilities').$type<string[]>().default([]).notNull(),
  partnerType: text('partner_type').default('supplier').notNull(),
  status: text('status').default('pending').notNull(),
  commissionRateBps: integer('commission_rate_bps'),
  reviewNote: text('review_note'),
  reviewedBy: text('reviewed_by').references(() => user.id),
  reviewedAt: timestamp('reviewed_at'),
  bankAccountName: text('bank_account_name'),
  bankAccountNumber: text('bank_account_number'),
  bankCode: text('bank_code'),
  bankAccountVerifiedAt: timestamp('bank_account_verified_at'),
  paystackRecipientCode: text('paystack_recipient_code'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const partnerDocuments = pgTable('partner_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  documentType: text('document_type').notNull(),
  storagePath: text('storage_path').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
