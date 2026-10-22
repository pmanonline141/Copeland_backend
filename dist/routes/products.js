import { Router } from 'express';
import { ProductService } from '../services/products.service.js';
import { requireAuth, requireRole, requireApprovedPartner } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { productCreateSchema, productModerationSchema, productUpdateSchema } from '../validation/schemas.js';
import { apiError } from '../http/responses.js';
export const productsRouter = Router();
productsRouter.get('/', async (req, res) => {
    const { q, category, size, label, page, limit, minPrice, maxPrice } = req.query;
    const asNumber = (value) => typeof value === 'string' ? Number(value) : undefined;
    const liveProducts = await ProductService.getLiveProducts({
        q: typeof q === 'string' ? q : undefined,
        category: typeof category === 'string' ? category : undefined,
        size: typeof size === 'string' ? size : undefined,
        isCopelandLabel: label === 'true' ? true : label === 'false' ? false : undefined,
        page: asNumber(page),
        limit: asNumber(limit),
        minPrice: asNumber(minPrice),
        maxPrice: asNumber(maxPrice),
    });
    res.json(liveProducts);
});
productsRouter.get('/:id', async (req, res) => {
    const product = await ProductService.getLiveProduct(String(req.params.id));
    if (!product)
        return res.status(404).json(apiError('PRODUCT_NOT_FOUND', 'Product not found'));
    res.json(product);
});
productsRouter.get('/mine', requireAuth, requireRole('supplier'), requireApprovedPartner, async (req, res) => {
    const supplierProducts = await ProductService.getPartnerProducts(req.partnerId);
    res.json(supplierProducts);
});
productsRouter.post('/', requireAuth, requireRole('supplier'), requireApprovedPartner, validateBody(productCreateSchema), async (req, res) => {
    try {
        const product = await ProductService.createProduct(req.partnerId, req.body);
        res.status(201).json(product);
    }
    catch (error) {
        res.status(400).json(apiError('PRODUCT_CREATE_FAILED', error instanceof Error ? error.message : 'Unable to create product'));
    }
});
productsRouter.post('/:id/submit', requireAuth, requireRole('supplier'), requireApprovedPartner, async (req, res) => {
    try {
        const product = await ProductService.submitForReview(String(req.params.id), req.partnerId);
        res.json(product);
    }
    catch (error) {
        res.status(400).json(apiError('PRODUCT_SUBMISSION_FAILED', error instanceof Error ? error.message : 'Unable to submit product'));
    }
});
productsRouter.patch('/:id', requireAuth, requireRole('supplier'), requireApprovedPartner, validateBody(productUpdateSchema), async (req, res) => {
    try {
        const product = await ProductService.updateProduct(String(req.params.id), req.partnerId, req.body);
        res.json(product);
    }
    catch (error) {
        res.status(400).json(apiError('PRODUCT_UPDATE_FAILED', error instanceof Error ? error.message : 'Unable to update product'));
    }
});
productsRouter.post('/:id/moderate', requireAuth, requireRole('admin', 'staff'), validateBody(productModerationSchema), async (req, res) => {
    try {
        const { action, reason } = req.body;
        if (!action)
            return res.status(400).json(apiError('INVALID_MODERATION_ACTION', 'Moderation action is required'));
        if (action === 'badge' && req.user.role !== 'admin') {
            return res.status(403).json(apiError('FORBIDDEN', 'Only admins can apply the Copeland badge'));
        }
        const product = await ProductService.moderateProduct(String(req.params.id), req.user.id, action, reason);
        res.json(product);
    }
    catch (error) {
        res.status(400).json(apiError('PRODUCT_MODERATION_FAILED', error instanceof Error ? error.message : 'Unable to moderate product'));
    }
});
