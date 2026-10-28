import { Router } from 'express';
import crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, partnerDocuments, partners, user } from '../db/schema/index.js';
import { requireAuth, requirePartnerAccount, requireRole } from '../middleware/auth.js';
import { sendTransactionalEmail } from '../services/notifications.service.js';
import { partnerApplicationReceivedEmail, partnerReviewEmail } from '../services/email-templates.js';
import { createPartnerDocumentSignature, markImagesAttached } from '../lib/cloudinary.js';
// If this line shows a red underline, open the src/auth folder and point it at the file that exports `auth`.
import { auth } from '../auth/auth.js';
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

const DOC_TYPES = ['cac', 'tin', 'id'];
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Lets a guest add documents to ONE pending application using the token returned when they applied. */
async function requireApplicationToken(req: any, res: any, next: any) {
  try {
    const token = req.header('x-application-token');
    const [application] = await db.select().from(partners).where(eq(partners.id, String(req.params.id)));
    const valid = !!token && !!application?.applicationTokenHash && application.status === 'pending'
      && crypto.timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(application.applicationTokenHash));
    if (!valid) {
      return res.status(401).json(apiError('INVALID_APPLICATION_TOKEN', 'This application link is invalid or has expired'));
    }
    req.application = application;
    next();
  } catch (error) {
    next(error);
  }
}

// Public: anyone can apply. No account is needed until the application is approved.
partnersRouter.post('/apply', applicationRateLimit, validateBody(partnerApplicationSchema), async (req, res) => {
  try {
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

    const email = contactEmail.trim().toLowerCase();
    const [existing] = await db.select({ id: partners.id }).from(partners).where(and(
      sql`(lower(${partners.contactEmail}) = ${email} or ${partners.cacNumber} = ${cacNumber.trim()})`,
      sql`${partners.status} in ('pending', 'approved', 'suspended')`,
    ));
    if (existing) {
      return res.status(409).json(apiError('APPLICATION_EXISTS', 'An application with this email or CAC number already exists. We will contact you after review.'));
    }

    const applicationToken = crypto.randomBytes(32).toString('hex');
    const [partner] = await db.insert(partners).values({
      userId: null,
      applicationTokenHash: sha256(applicationToken),
      businessName: businessName.trim(),
      companyName: companyName.trim(),
      cacNumber: cacNumber.trim(),
      tin: tin.trim(),
      contactName: contactName.trim(),
      contactEmail: email,
      contactPhone: contactPhone.trim(),
      address: address.trim(),
      capabilities,
      partnerType,
      status: 'pending',
    }).returning();

      try {
      await sendTransactionalEmail(partnerApplicationReceivedEmail(
        partner.contactEmail!,
        partner.contactName!,
      ));
    } catch (emailError) {
      console.error('Partner confirmation email failed', emailError);
    }

    // The token goes back once, to the applicant's browser only, so it can upload documents.
    res.status(201).json({ id: partner.id, status: partner.status, applicationToken });
  } catch (error) {
    res.status(500).json(apiError('PARTNER_APPLICATION_FAILED', error instanceof Error ? error.message : 'Unable to submit partner application'));
  }
});

// Public (token-protected): document upload for a guest application.
partnersRouter.post('/applications/:id/documents/sign-upload', applicationRateLimit, requireApplicationToken, validateBody(documentUploadSchema), async (req, res) => {
  try {
    const { documentType } = req.body as { documentType?: string };
    if (!DOC_TYPES.includes(documentType ?? '')) {
      return res.status(400).json(apiError('INVALID_DOCUMENT', 'A supported document type is required'));
    }
    res.status(201).json(createPartnerDocumentSignature((req as any).application.id, documentType!));
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_SIGN_FAILED', error instanceof Error ? error.message : 'Unable to create document upload signature'));
  }
});

partnersRouter.post('/applications/:id/documents/attach', applicationRateLimit, requireApplicationToken, async (req, res) => {
  try {
    const { documentType, url } = req.body as { documentType: string; url: string };
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    if (!url || !DOC_TYPES.includes(documentType) || !cloud || !url.startsWith(`https://res.cloudinary.com/${cloud}/`)) {
      return res.status(400).json(apiError('INVALID_ATTACHMENT', 'Document type and a valid upload URL are required'));
    }
    const [document] = await db.insert(partnerDocuments).values({
      partnerId: (req as any).application.id,
      documentType,
      storagePath: url,
    }).returning();
    // Uploads are tagged "pending" and swept after 24h; this keeps the document.
    await markImagesAttached([url]);
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_ATTACH_FAILED', error instanceof Error ? error.message : 'Unable to attach document'));
  }
});

/** Finds or creates the login for an approved partner. No password is emailed; they set their own via a link. */
async function provisionPartnerAccount(partner: typeof partners.$inferSelect) {
  const email = partner.contactEmail!.toLowerCase();
  const [existingUser] = await db.select().from(user).where(eq(user.email, email));
  if (existingUser) {
    if (existingUser.role === 'admin' || existingUser.role === 'staff') {
      throw new Error('INTERNAL_ACCOUNT');
    }
    return { userId: existingUser.id, newAccount: false };
  }
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser(
    { email, name: partner.contactName ?? partner.businessName, emailVerified: true, role: partner.partnerType },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: await ctx.password.hash(crypto.randomBytes(32).toString('hex')),
  });
  return { userId: created.id, newAccount: true };
}

partnersRouter.post('/documents/sign-upload', requireAuth, requirePartnerAccount, validateBody(documentUploadSchema), async (req, res) => {
  try {
    const { documentType } = req.body as { documentType?: string };
    if (!['cac', 'tin', 'id'].includes(documentType ?? '')) {
      return res.status(400).json(apiError('INVALID_DOCUMENT', 'A supported document type is required'));
    }
    
    const signature = createPartnerDocumentSignature(req.partnerId!, documentType!);
    res.status(201).json(signature);
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_SIGN_FAILED', error instanceof Error ? error.message : 'Unable to create document upload signature'));
  }
});

partnersRouter.post('/documents/attach', requireAuth, requirePartnerAccount, async (req, res) => {
  try {
    const { documentType, url } = req.body as { documentType: string; url: string };
    if (!url || !['cac', 'tin', 'id'].includes(documentType)) {
      return res.status(400).json(apiError('INVALID_ATTACHMENT', 'Document type and URL are required'));
    }

    const [document] = await db.insert(partnerDocuments).values({
      partnerId: req.partnerId!,
      documentType,
      storagePath: url, // Store the Cloudinary URL as the path
    }).returning();
    await markImagesAttached([url]);

    res.status(201).json(document);
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_ATTACH_FAILED', error instanceof Error ? error.message : 'Unable to attach document'));
  }
});

partnersRouter.get('/:id/documents/:documentId/download-url', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [document] = await db.select().from(partnerDocuments)
      .where(eq(partnerDocuments.id, String(req.params.documentId)));
    if (!document || document.partnerId !== String(req.params.id)) {
      return res.status(404).json(apiError('DOCUMENT_NOT_FOUND', 'Document not found'));
    }
    // For Cloudinary, we just return the stored URL (or a signed one if private)
    // Since we didn't set 'type: private', it's a direct URL.
    res.json({ signedUrl: document.storagePath });
  } catch (error) {
    res.status(500).json(apiError('DOCUMENT_DOWNLOAD_URL_FAILED', error instanceof Error ? error.message : 'Unable to get document URL'));
  }
});

partnersRouter.post('/:id/review', requireAuth, requireRole('admin'), validateBody(partnerReviewSchema), async (req, res) => {
  try {
    const { status, reviewNote } = req.body as { status?: string; reviewNote?: string };
    if (!['approved', 'rejected', 'suspended'].includes(status ?? '')) {
      return res.status(400).json(apiError('INVALID_PARTNER_REVIEW', 'Review status must be approved, rejected, or suspended'));
    }

    let account: { userId: string; newAccount: boolean } | null = null;
    if (status === 'approved') {
      const [applicant] = await db.select().from(partners).where(eq(partners.id, String(req.params.id)));
      if (!applicant) return res.status(404).json(apiError('PARTNER_NOT_FOUND', 'Partner not found'));
      try {
        account = await provisionPartnerAccount(applicant);
      } catch (error) {
        if (error instanceof Error && error.message === 'INTERNAL_ACCOUNT') {
          return res.status(409).json(apiError('INTERNAL_ACCOUNT', 'This email belongs to an internal Copeland account and cannot become a partner'));
        }
        throw error;
      }
    }

    const updated = await db.transaction(async (tx) => {
      const [partner] = await tx.update(partners)
        .set({
          ...(account ? { userId: account.userId } : {}),
          status: status!,
          reviewNote: reviewNote?.trim() || null,
          reviewedBy: req.user!.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(partners.id, String(req.params.id)))
        .returning();
      if (partner && status === 'approved' && account) {
        await tx.update(user)
          .set({ role: partner.partnerType, updatedAt: new Date() })
          .where(eq(user.id, account.userId));
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

    // New account: email a "set your password" link so they can log in. Never blocks the decision.
    if (account?.newAccount) {
      try {
        const base = process.env.FRONTEND_URL ?? process.env.FRONTEND_ORIGINS?.split(',')[0]?.trim() ?? '';
        await auth.api.requestPasswordReset({ body: { email: updated.contactEmail!, redirectTo: `${base}/reset-password` } });
      } catch { /* an admin can resend later */ }
    }

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

partnersRouter.get('/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const [partner] = await db.select().from(partners).where(eq(partners.id, String(req.params.id)));
    if (!partner) return res.status(404).json(apiError('PARTNER_NOT_FOUND', 'Partner not found'));
    
    const documents = await db.select().from(partnerDocuments).where(eq(partnerDocuments.partnerId, partner.id));
    
    res.json({ ...partner, documents });
  } catch (error) {
    res.status(500).json(apiError('PARTNER_FETCH_FAILED', error instanceof Error ? error.message : 'Unable to fetch partner details'));
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