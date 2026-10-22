import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, moderationRecords, partners, productInventory, products } from '../db/schema/index.js';
import { sendTransactionalEmail } from './notifications.service.js';
import { productModerationEmail } from './email-templates.js';
export function toPublicProduct(product, supplierName) {
    const { partnerId, ...publicProduct } = product;
    return {
        ...publicProduct,
        supplier: product.isCopelandLabel ? null : { name: supplierName, id: partnerId },
    };
}
export function statusAfterSupplierEdit(currentStatus) {
    return currentStatus === 'approved' || currentStatus === 'paused' ? 'submitted' : 'draft';
}
export function assertProductHasSubmissionImages(images) {
    if (images.length < 3)
        throw new Error('At least three product images are required before submission');
}
export class ProductService {
    static async createProduct(partnerId, data) {
        const [product] = await db.transaction(async (tx) => {
            const [created] = await tx.insert(products).values({
                partnerId,
                name: data.name,
                description: data.description,
                category: data.category,
                priceKobo: data.priceKobo,
                moq: data.moq,
                quantityAvailable: data.quantityAvailable ?? 0,
                colours: data.colours ?? [],
                sizes: data.sizes ?? [],
                images: data.images ?? [],
                tier: data.tier ?? 'standard',
                isCopelandLabel: false,
                status: 'draft',
            }).returning();
            if (data.inventory?.length) {
                await tx.insert(productInventory).values(data.inventory.map((variant) => ({
                    productId: created.id,
                    size: variant.size ?? '',
                    colour: variant.colour ?? '',
                    quantityAvailable: variant.quantityAvailable,
                })));
            }
            return [created];
        });
        return product;
    }
    static async updateProduct(productId, partnerId, data) {
        const [existing] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.partnerId, partnerId)));
        if (!existing)
            throw new Error('Product not found or unauthorized');
        const updateData = {};
        for (const key of ['name', 'description', 'category', 'priceKobo', 'moq', 'quantityAvailable', 'colours', 'sizes', 'images', 'tier']) {
            if (data[key] !== undefined)
                Object.assign(updateData, { [key]: data[key] });
        }
        const status = statusAfterSupplierEdit(existing.status);
        const [updated] = await db.update(products)
            .set({ ...updateData, status, updatedAt: new Date() })
            .where(and(eq(products.id, productId), eq(products.partnerId, partnerId)))
            .returning();
        return updated;
    }
    static async submitForReview(productId, partnerId) {
        const [existing] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.partnerId, partnerId)));
        if (!existing)
            throw new Error('Product not found or unauthorized');
        assertProductHasSubmissionImages(existing.images);
        const [product] = await db.update(products)
            .set({ status: 'submitted', updatedAt: new Date() })
            .where(and(eq(products.id, productId), eq(products.partnerId, partnerId)))
            .returning();
        return product;
    }
    static async moderateProduct(productId, moderatorId, action, reason) {
        if ((action === 'reject' || action === 'changes_requested') && !reason?.trim()) {
            throw new Error('A reason is required for rejection or requested changes');
        }
        const statusMap = {
            approve: 'approved',
            reject: 'rejected',
            changes_requested: 'changes_requested',
            pause: 'paused',
            badge: 'approved',
        };
        const product = await db.transaction(async (tx) => {
            const [product] = await tx.update(products)
                .set({
                status: statusMap[action],
                ...(action === 'badge' ? { isCopelandLabel: true } : {}),
                rejectionReason: action === 'reject' || action === 'changes_requested' ? reason.trim() : null,
                updatedAt: new Date(),
            })
                .where(eq(products.id, productId))
                .returning();
            if (!product)
                throw new Error('Product not found');
            await tx.insert(moderationRecords).values({
                productId,
                moderatorId,
                decision: action,
                reason: reason?.trim() || null,
            });
            await tx.insert(auditLog).values({
                actorId: moderatorId,
                action: `product.${action}`,
                entityType: 'product',
                entityId: product.id,
                details: { reason: reason?.trim() || null },
            });
            return product;
        });
        if (action === 'approve' || action === 'reject' || action === 'changes_requested') {
            const [partner] = await db.select({
                contactEmail: partners.contactEmail,
                businessName: partners.businessName,
            }).from(partners).where(eq(partners.id, product.partnerId));
            if (!partner?.contactEmail)
                throw new Error('Supplier contact email is missing');
            const subject = action === 'approve'
                ? 'Your Copeland product has been approved'
                : action === 'reject'
                    ? 'Your Copeland product was rejected'
                    : 'Changes are requested for your Copeland product';
            await sendTransactionalEmail(productModerationEmail(partner.contactEmail, product.name, subject, reason?.trim() || subject));
        }
        return product;
    }
    static async getLiveProducts(filters = {}) {
        const page = Math.max(1, Math.floor(filters.page ?? 1));
        const limit = Math.min(100, Math.max(1, Math.floor(filters.limit ?? 20)));
        const clauses = [
            eq(products.status, 'approved'),
            eq(partners.status, 'approved'),
        ];
        if (filters.category)
            clauses.push(eq(products.category, filters.category));
        if (filters.minPrice !== undefined)
            clauses.push(gte(products.priceKobo, filters.minPrice));
        if (filters.maxPrice !== undefined)
            clauses.push(lte(products.priceKobo, filters.maxPrice));
        if (filters.isCopelandLabel !== undefined)
            clauses.push(eq(products.isCopelandLabel, filters.isCopelandLabel));
        if (filters.size)
            clauses.push(sql `${products.sizes} @> ${JSON.stringify([filters.size])}::jsonb`);
        if (filters.q?.trim()) {
            clauses.push(sql `to_tsvector('simple', ${products.name} || ' ' || ${products.description} || ' ' || ${products.category})
        @@ plainto_tsquery('simple', ${filters.q.trim()})`);
        }
        const rows = await db.select({
            product: products,
            supplierName: partners.businessName,
        }).from(products)
            .innerJoin(partners, eq(products.partnerId, partners.id))
            .where(and(...clauses))
            .limit(limit)
            .offset((page - 1) * limit);
        return rows.map(({ product, supplierName }) => toPublicProduct(product, supplierName));
    }
    static async getLiveProduct(productId) {
        const rows = await db.select({
            product: products,
            supplierName: partners.businessName,
        }).from(products)
            .innerJoin(partners, eq(products.partnerId, partners.id))
            .where(and(eq(products.id, productId), eq(products.status, 'approved'), eq(partners.status, 'approved')));
        const row = rows[0];
        if (!row)
            return null;
        return toPublicProduct(row.product, row.supplierName);
    }
    static async getPartnerProducts(partnerId) {
        return db.select().from(products).where(eq(products.partnerId, partnerId));
    }
}
