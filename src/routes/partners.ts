import { Router } from 'express';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, partnerDocuments, partners, user } from '../db/schema/index.js';
import { requireAuth, requirePartnerAccount, requireRole } from '../middleware/auth.js';
import { sendTransactionalEmail } from '../services/notifications.service.js';
import { partnerApplicationReceivedEmail, partnerReviewEmail } from '../services/email-templates.js';
import { createPartnerDocumentDownload, createPartnerDocumentUpload } from '../services/supabase-storage.service.js';
import { validateBody } from '../middleware/validation.js';
import { applicationRateLimit } from '../middleware/rate-limits.js';
import { apiError } from '../http/responses.js';
import {
  bankDetailsSchema,
  commissionSchema,
  documentUploadSchema,
  partnerApplicationSchema,
  partnerReviewSchema,
} from '../validation/schemas.js';

export const partnersRouter = Router();

partnersRouter.post('/apply', applicationRateLimit, requireAuth, validateBody(partnerApplicationSchema), async (req, res) => {
  try {
    const userId = req.user!.id;
    const {
      companyName,
      businessName = companyName,
      cacNumber,
      tin,
      contactName,
      contactEmail,
      contactPhone,
      address,
      capabilities,
      partnerType = 'supplier',
    } = req.body;

    if (
      typeof companyName !== 'string' || !companyName.trim()
      || typeof cacNumber !== 'string' || !cacNumber.trim()
      || typeof tin !== 'string' || !tin.trim()
      || typeof contactName !== 'string' || !contactName.trim()
      || typeof contactEmail !== 'string' || !contactEmail.trim()
      || typeof contactPhone !== 'string' || !contactPhone.trim()
      || typeof address !== 'string' || !address.trim()
      || !Array.isArray(capabilities) || capabilities.length === 0
      || !capabilities.every((capability: unknown) => typeof capability === 'string' && capability.trim())
      || !['supplier', 'shipping'].includes(partnerType)
    ) {
      return res.status(400).json(apiError('INVALID_APPLICATION', 'Complete company, registration, contact, address, capability, and partner type details are required'));
    }

    const [existing] = await db.select().from(partners).where(eq(partners.userId, userId));
    if (existing) return res.status(400).json(apiError('APPLICATION_EXISTS', 'Application already exists'));

    const [partner] = await db.insert(partners).values({
      userId,
      businessName: businessName.trim(),
      companyName: companyName.trim(),
      cacNumber: cacNumber.trim(),
      tin: tin.trim(),
      contactName: contactName.trim(),
      contactEmail: contactEmail.trim().toLowerCase(),
      contactPhone: contactPhone.trim(),
      address: address.trim(),
      capabilities,
      partnerType,
      status: 'pending',
    }).returning();

    await sendTransactionalEmail(partnerApplicationReceivedEmail(
      partner.contactEmail!,
      partner.contactName!,
    ));
    res.status(201).json(partner);
  } catch (error) {
    res.status(500).json(apiError('PARTNER_APPLICATION_FAILED', error instanceof Error ? error.message : 'Unable to submit partner application'));
  }
});

partnersRouter.post('/documents/upload-url', requireAuth, requirePartnerAccount, validateBody(documentUploadSchema), async (req, res) => {
  try {
    const { documentType, fileName } = req.body as { documentType?: string; fileName?: string };
    if (!['cac', 'tin', 'id'].includes(documentType ?? '') || !fileName || fileName.length > 120) {
      return res.status(400).json(apiError('INVALID_DOCUMENT', 'A supported document type and file name are required'));
    }
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${req.partnerId}/${documentType}/${crypto.randomUUID()}-${safeFileName}`;
    const upload = await createPartnerDocumentUpload(storagePath);
    const [document] = await db.insert(partnerDocuments).values({
      partnerId: req.partnerId!,
      documentType: documentType!,
      storagePath,
    }).returning({ id: partnerDocuments.id });
    res.status(201).json({
      documentId: document.id,
      path: upload.path,
      token: upload.token,
      signedUrl: upload.signedUrl,
    });
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_UPLOAD_URL_FAILED', error instanceof Error ? error.message : 'Unable to create document upload URL'));
  }
});

partnersRouter.get('/:id/documents/:documentId/download-url', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [document] = await db.select().from(partnerDocuments)
      .where(eq(partnerDocuments.id, String(req.params.documentId)));
    if (!document || document.partnerId !== String(req.params.id)) {
      return res.status(404).json(apiError('DOCUMENT_NOT_FOUND', 'Document not found'));
    }
    const signed = await createPartnerDocumentDownload(document.storagePath);
    res.json({ signedUrl: signed.signedUrl });
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_DOWNLOAD_URL_FAILED', error instanceof Error ? error.message : 'Unable to create document download URL'));
  }
});

partnersRouter.post('/:id/review', requireAuth, requireRole('admin'), validateBody(partnerReviewSchema), async (req, res) => {
  try {
    const { status, reviewNote } = req.body as { status?: string; reviewNote?: string };
    if (!['approved', 'rejected', 'suspended'].includes(status ?? '')) {
      return res.status(400).json(apiError('INVALID_PARTNER_REVIEW', 'Review status must be approved, rejected, or suspended'));
    }

    const updated = await db.transaction(async (tx) => {
      const [partner] = await tx.update(partners)
        .set({
          status: status!,
          reviewNote: reviewNote?.trim() || null,
          reviewedBy: req.user!.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(partners.id, String(req.params.id)))
        .returning();
      if (partner && status === 'approved') {
        await tx.update(user)
          .set({ role: partner.partnerType, updatedAt: new Date() })
          .where(eq(user.id, partner.userId));
      }
      if (partner) {
        await tx.insert(auditLog).values({
          actorId: req.user!.id,
          action: `partner.${status}`,
          entityType: 'partner',
          entityId: partner.id,
          details: { reviewNote: reviewNote?.trim() || null },
        });
      }
      return partner;
    });
    if (!updated) return res.status(404).json(apiError('PARTNER_NOT_FOUND', 'Partner not found'));

    await sendTransactionalEmail(partnerReviewEmail(
      updated.contactEmail!,
      updated.contactName ?? updated.businessName,
      status as 'approved' | 'rejected' | 'suspended',
      reviewNote?.trim(),
      `${process.env.FRONTEND_URL ?? process.env.FRONTEND_ORIGINS?.split(',')[0]?.trim() ?? process.env.BETTER_AUTH_URL}/login`,
    ));
    res.json(updated);
  } catch (error) {
    res.status(500).json(apiError('PARTNER_REVIEW_FAILED', error instanceof Error ? error.message : 'Unable to review partner'));
  }
});

partnersRouter.put('/:id/commission', requireAuth, requireRole('admin'), validateBody(commissionSchema), async (req, res) => {
  try {
    const { commissionRateBps } = req.body as { commissionRateBps?: number | null };
    if (commissionRateBps !== null && (typeof commissionRateBps !== 'number'
      || !Number.isSafeInteger(commissionRateBps)
      || commissionRateBps < 0
      || commissionRateBps > 10_000)) {
      return res.status(400).json(apiError('INVALID_COMMISSION_RATE', 'Commission rate must be an integer from 0 to 10000 basis points, or null to use the default'));
    }
    const partner = await db.transaction(async (tx) => {
      const [updated] = await tx.update(partners)
        .set({ commissionRateBps: commissionRateBps ?? null, updatedAt: new Date() })
        .where(eq(partners.id, String(req.params.id)))
        .returning({
          id: partners.id,
          commissionRateBps: partners.commissionRateBps,
        });
      if (updated) {
        await tx.insert(auditLog).values({
          actorId: req.user!.id,
          action: 'partner.commission_changed',
          entityType: 'partner',
          entityId: updated.id,
          details: { commissionRateBps: updated.commissionRateBps },
        });
      }
      return updated;
    });
    if (!partner) return res.status(404).json(apiError('PARTNER_NOT_FOUND', 'Partner not found'));
    res.json(partner);
  } catch (error) {
    res.status(500).json(apiError('COMMISSION_UPDATE_FAILED', error instanceof Error ? error.message : 'Unable to update commission rate'));
  }
});

partnersRouter.post('/bank-details/verify', requireAuth, requirePartnerAccount, validateBody(bankDetailsSchema), async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body as { accountNumber?: string; bankCode?: string };
    if (!accountNumber || !/^\d{10}$/.test(accountNumber) || !bankCode) {
      return res.status(400).json(apiError('INVALID_BANK_DETAILS', 'A 10-digit account number and bank code are required'));
    }

    const [currentPartner] = await db.select().from(partners).where(eq(partners.id, req.partnerId!));
    if (
      currentPartner?.bankAccountNumber === accountNumber
      && currentPartner.bankCode === bankCode
      && currentPartner.bankAccountVerifiedAt
      && currentPartner.paystackRecipientCode
    ) {
      return res.json({
        id: currentPartner.id,
        bankAccountName: currentPartner.bankAccountName,
        bankAccountVerifiedAt: currentPartner.bankAccountVerifiedAt,
      });
    }

    const authorization = { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
    const resolveUrl = new URL('https://api.paystack.co/bank/resolve');
    resolveUrl.searchParams.set('account_number', accountNumber);
    resolveUrl.searchParams.set('bank_code', bankCode);
    const resolveResponse = await fetch(resolveUrl, { headers: authorization });
    const resolved = await resolveResponse.json() as {
      status?: boolean;
      message?: string;
      data?: { account_name?: string };
    };
    if (!resolveResponse.ok || !resolved.status || !resolved.data?.account_name) {
      return res.status(400).json(apiError('BANK_ACCOUNT_VERIFICATION_FAILED', resolved.message ?? 'Paystack account verification failed'));
    }

    const recipientResponse = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'nuban',
        name: resolved.data.account_name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });
    const recipientData = await recipientResponse.json() as {
      status?: boolean;
      message?: string;
      data?: { recipient_code?: string };
    };
    if (!recipientResponse.ok || !recipientData.status || !recipientData.data?.recipient_code?.startsWith('RCP_')) {
      return res.status(400).json(apiError('RECIPIENT_CREATION_FAILED', recipientData.message ?? 'Paystack transfer recipient creation failed'));
    }

    const [updatedPartner] = await db.update(partners)
      .set({
        bankAccountName: resolved.data.account_name,
        bankAccountNumber: accountNumber,
        bankCode,
        bankAccountVerifiedAt: new Date(),
        paystackRecipientCode: recipientData.data.recipient_code,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, req.partnerId!))
      .returning({
        id: partners.id,
        bankAccountName: partners.bankAccountName,
        bankAccountVerifiedAt: partners.bankAccountVerifiedAt,
      });
    res.json(updatedPartner);
  } catch (error) {
    res.status(500).json(apiError('BANK_DETAILS_UPDATE_FAILED', error instanceof Error ? error.message : 'Unable to verify bank details'));
  }
});

partnersRouter.get('/', requireAuth, requireRole('admin', 'staff'), async (_req, res) => {
  const status = typeof _req.query.status === 'string' ? _req.query.status : undefined;
  const partnerType = typeof _req.query.type === 'string' ? _req.query.type : undefined;
  const filters = status && partnerType
    ? and(eq(partners.status, status), eq(partners.partnerType, partnerType))
    : status
      ? eq(partners.status, status)
      : partnerType
        ? eq(partners.partnerType, partnerType)
        : undefined;
  const partnerList = await db.select({
    id: partners.id,
    userId: partners.userId,
    businessName: partners.businessName,
    companyName: partners.companyName,
    partnerType: partners.partnerType,
    status: partners.status,
    reviewNote: partners.reviewNote,
    reviewedBy: partners.reviewedBy,
    reviewedAt: partners.reviewedAt,
    createdAt: partners.createdAt,
  }).from(partners).where(filters);
  res.json(partnerList);
});
