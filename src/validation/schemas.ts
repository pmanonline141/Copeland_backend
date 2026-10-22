import { z } from 'zod';

const email = z.string().trim().email().max(254);
const uuid = z.string().uuid();
const productOrderItem = z.object({
  productId: uuid,
  quantity: z.number().int().positive(),
  size: z.string().trim().max(50).optional(),
  colour: z.string().trim().max(50).optional(),
});

export const partnerApplicationSchema = z.object({
  businessName: z.string().trim().min(1).max(200).optional(),
  companyName: z.string().trim().min(1).max(200),
  cacNumber: z.string().trim().min(1).max(100),
  tin: z.string().trim().min(1).max(100),
  contactName: z.string().trim().min(1).max(200),
  contactEmail: email,
  contactPhone: z.string().trim().min(5).max(40),
  address: z.string().trim().min(5).max(1000),
  capabilities: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  partnerType: z.enum(['supplier', 'shipping']).default('supplier'),
});

export const documentUploadSchema = z.object({
  documentType: z.enum(['cac', 'tin', 'id']),
  fileName: z.string().min(1).max(120),
});

export const partnerReviewSchema = z.object({
  status: z.enum(['approved', 'rejected', 'suspended']),
  reviewNote: z.string().trim().max(2000).optional(),
});

export const commissionSchema = z.object({
  commissionRateBps: z.number().int().min(0).max(10_000).nullable(),
});

export const bankDetailsSchema = z.object({
  accountNumber: z.string().regex(/^\d{10}$/),
  bankCode: z.string().trim().min(1).max(20),
});

const productFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  category: z.string().trim().min(1).max(100),
  priceKobo: z.number().int().nonnegative(),
  moq: z.number().int().positive().optional(),
  quantityAvailable: z.number().int().nonnegative().optional(),
  colours: z.array(z.string().trim().min(1).max(50)).optional(),
  sizes: z.array(z.string().trim().min(1).max(50)).optional(),
  images: z.array(z.string().url()).max(30).optional(),
  tier: z.string().trim().max(50).optional(),
  inventory: z.array(z.object({
    size: z.string().trim().max(50).optional(),
    colour: z.string().trim().max(50).optional(),
    quantityAvailable: z.number().int().nonnegative(),
  })).max(500).optional(),
};

export const productCreateSchema = z.object(productFields);
export const productUpdateSchema = z.object({
  name: productFields.name.optional(),
  description: productFields.description.optional(),
  category: productFields.category.optional(),
  priceKobo: productFields.priceKobo.optional(),
  moq: productFields.moq,
  quantityAvailable: productFields.quantityAvailable,
  colours: productFields.colours,
  sizes: productFields.sizes,
  images: productFields.images,
  tier: productFields.tier,
}).refine((data) => Object.values(data).some((value) => value !== undefined), 'At least one product field is required');
export const productModerationSchema = z.object({
  action: z.enum(['approve', 'reject', 'changes_requested', 'pause', 'badge']),
  reason: z.string().trim().max(2000).optional(),
});

export const checkoutSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email,
  phone: z.string().trim().min(5).max(40).optional(),
  items: z.array(productOrderItem).min(1).max(100),
});
export const cancelOrderSchema = z.object({ email });
export const guestOrderLookupSchema = z.object({
  orderNumber: z.string().trim().min(1).max(100),
  email,
});
export const fulfillmentStatusSchema = z.object({ status: z.enum(['packed', 'shipped', 'delivered']) });
export const assignShippingSchema = z.object({ shippingPartnerId: uuid });
export const rfqSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email,
  phone: z.string().trim().min(5).max(40).optional(),
  items: z.array(productOrderItem).min(1).max(100),
  details: z.string().trim().max(5000).optional(),
});
export const rfqAdminUpdateSchema = z.object({
  status: z.enum(['in_review', 'quoted', 'declined', 'closed']),
  quoteAmountKobo: z.number().int().nonnegative().optional(),
  quoteMessage: z.string().trim().max(5000).optional(),
});
export const rfqResponseSchema = z.object({ email, accepted: z.boolean() });
export const shipmentCreateSchema = z.object({
  orderId: uuid,
  trackingNumber: z.string().trim().min(1).max(200),
});
export const shipmentUpdateSchema = z.object({
  status: z.enum(['picked_up', 'in_transit', 'delivered']),
  note: z.string().trim().max(2000).optional(),
});
export const manualPayoutSchema = z.object({ reference: z.string().trim().min(1).max(200) });
export const adjustmentSchema = z.object({
  amountKobo: z.number().int().refine((amount) => amount !== 0),
  note: z.string().trim().min(1).max(2000),
  orderId: uuid.optional(),
});
