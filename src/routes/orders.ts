import { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth/auth.js';
import { OrderService } from '../services/orders.service.js';
import { FulfillmentService } from '../services/fulfillment.service.js';
import { requireApprovedPartner, requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { apiError } from '../http/responses.js';
import { checkoutRateLimit } from '../middleware/rate-limits.js';
import {
  assignShippingSchema,
  cancelOrderSchema,
  checkoutSchema,
  fulfillmentStatusSchema,
  guestOrderLookupSchema,
  rfqAdminUpdateSchema,
  rfqResponseSchema,
  rfqSchema,
  shipmentCreateSchema,
  shipmentUpdateSchema,
} from '../validation/schemas.js';

export const ordersRouter = Router();

ordersRouter.get('/supplier', requireAuth, requireRole('supplier'), requireApprovedPartner, async (req, res) => {
  const supplierOrders = await FulfillmentService.getSupplierOrders(req.partnerId!);
  res.json(supplierOrders);
});

ordersRouter.patch('/:orderId/items/:orderItemId/fulfillment', requireAuth, requireRole('supplier'), requireApprovedPartner, validateBody(fulfillmentStatusSchema), async (req, res) => {
  try {
    const { status } = req.body as { status?: 'packed' | 'shipped' | 'delivered' };
    if (!status || !['packed', 'shipped', 'delivered'].includes(status)) {
      return res.status(400).json(apiError('INVALID_FULFILLMENT_STATUS', 'Fulfillment status must be packed, shipped, or delivered'));
    }
    const item = await FulfillmentService.updateItemFulfillment(
      String(req.params.orderId),
      String(req.params.orderItemId),
      req.partnerId!,
      status,
    );
    res.json(item);
  } catch (error) {
    res.status(400).json(apiError('FULFILLMENT_UPDATE_FAILED', error instanceof Error ? error.message : 'Unable to update fulfillment status'));
  }
});

ordersRouter.put('/:orderId/shipping-partner', requireAuth, requireRole('admin', 'staff'), validateBody(assignShippingSchema), async (req, res) => {
  try {
    const { shippingPartnerId } = req.body as { shippingPartnerId?: string };
    if (!shippingPartnerId) return res.status(400).json(apiError('INVALID_SHIPPING_PARTNER', 'Shipping partner id is required'));
    const order = await FulfillmentService.assignShippingPartner(String(req.params.orderId), shippingPartnerId);
    res.json(order);
  } catch (error) {
    res.status(400).json(apiError('SHIPPING_ASSIGNMENT_FAILED', error instanceof Error ? error.message : 'Unable to assign shipping partner'));
  }
});

ordersRouter.post('/rfqs', validateBody(rfqSchema), async (req, res) => {
  try {
    const { name, email, phone, items, details } = req.body;
    if (!name || !email || !Array.isArray(items)) {
      return res.status(400).json(apiError('INVALID_RFQ', 'Requester name, email, and items are required'));
    }

    let requesterId: string | undefined;
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session?.user?.id) {
        requesterId = session.user.id;
      }
    } catch {
      // Guest RFQ
    }

    const rfq = await FulfillmentService.createRfq({
      requesterId,
      requesterName: name,
      requesterEmail: email,
      requesterPhone: phone,
      items,
      details,
    });
    res.status(201).json(rfq);
  } catch (error) {
    res.status(400).json(apiError('RFQ_CREATE_FAILED', error instanceof Error ? error.message : 'Unable to submit RFQ'));
  }
});

ordersRouter.get('/rfqs/buyer', requireAuth, requireRole('buyer', 'admin', 'staff'), async (req, res) => {
  try {
    const buyerRfqs = await FulfillmentService.getBuyerRfqs(req.user!.id);
    res.json(buyerRfqs);
  } catch (error) {
    res.status(500).json(apiError('BUYER_RFQS_FAILED', error instanceof Error ? error.message : 'Unable to fetch RFQs'));
  }
});

ordersRouter.get('/rfqs', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(await FulfillmentService.listRfqs(status));
});

ordersRouter.patch('/rfqs/:id', requireAuth, requireRole('admin', 'staff'), validateBody(rfqAdminUpdateSchema), async (req, res) => {
  try {
    const { status, quoteAmountKobo, quoteMessage } = req.body as {
      status?: 'in_review' | 'quoted' | 'accepted' | 'declined' | 'closed';
      quoteAmountKobo?: number;
      quoteMessage?: string;
    };
    if (!status) return res.status(400).json(apiError('INVALID_RFQ_STATUS', 'RFQ status is required'));
    const rfq = await FulfillmentService.updateRfqByAdmin(
      String(req.params.id),
      req.user!.id,
      status,
      quoteAmountKobo,
      quoteMessage,
    );
    res.json(rfq);
  } catch (error) {
    res.status(400).json(apiError('RFQ_UPDATE_FAILED', error instanceof Error ? error.message : 'Unable to update RFQ'));
  }
});

ordersRouter.post('/rfqs/:id/respond', validateBody(rfqResponseSchema), async (req, res) => {
  try {
    const { email, accepted } = req.body as { email?: string; accepted?: boolean };
    if (!email || typeof accepted !== 'boolean') {
      return res.status(400).json(apiError('INVALID_RFQ_RESPONSE', 'Email and accepted boolean are required'));
    }
    const rfq = await FulfillmentService.respondToRfq(String(req.params.id), email, accepted);
    res.json(rfq);
  } catch (error) {
    res.status(400).json(apiError('RFQ_RESPONSE_FAILED', error instanceof Error ? error.message : 'Unable to respond to RFQ'));
  }
});

ordersRouter.get('/shipping/assignments', requireAuth, requireRole('shipping'), requireApprovedPartner, async (req, res) => {
  try {
    const assignments = await FulfillmentService.getShippingAssignments(req.partnerId!);
    res.json(assignments);
  } catch (error) {
    res.status(500).json(apiError('SHIPPING_ASSIGNMENTS_FAILED', error instanceof Error ? error.message : 'Unable to fetch assigned deliveries'));
  }
});

ordersRouter.post('/shipping/shipments', requireAuth, requireRole('shipping'), requireApprovedPartner, validateBody(shipmentCreateSchema), async (req, res) => {
  try {
    const { orderId, trackingNumber } = req.body as { orderId?: string; trackingNumber?: string };
    if (!orderId || !trackingNumber) return res.status(400).json(apiError('INVALID_SHIPMENT', 'Order id and tracking number are required'));
    const shipment = await FulfillmentService.createShipment(orderId, req.partnerId!, trackingNumber);
    res.status(201).json(shipment);
  } catch (error) {
    res.status(400).json(apiError('SHIPMENT_CREATE_FAILED', error instanceof Error ? error.message : 'Unable to create shipment'));
  }
});

ordersRouter.patch('/shipping/shipments/:id', requireAuth, requireRole('shipping'), requireApprovedPartner, validateBody(shipmentUpdateSchema), async (req, res) => {
  try {
    const { status, note } = req.body as {
      status?: 'picked_up' | 'in_transit' | 'delivered';
      note?: string;
    };
    if (!status || !['picked_up', 'in_transit', 'delivered'].includes(status)) {
      return res.status(400).json(apiError('INVALID_SHIPMENT_STATUS', 'Shipment status must be picked_up, in_transit, or delivered'));
    }
    const shipment = await FulfillmentService.updateShipment(String(req.params.id), req.partnerId!, status, note);
    res.json(shipment);
  } catch (error) {
    res.status(400).json(apiError('SHIPMENT_UPDATE_FAILED', error instanceof Error ? error.message : 'Unable to update shipment'));
  }
});

ordersRouter.get('/buyer', requireAuth, requireRole('buyer', 'admin', 'staff'), async (req, res) => {
  try {
    const buyerOrders = await OrderService.getBuyerOrders(req.user!.id);
    res.json(buyerOrders);
  } catch (error) {
    res.status(500).json(apiError('BUYER_ORDERS_FAILED', error instanceof Error ? error.message : 'Unable to fetch buyer orders'));
  }
});

ordersRouter.post('/checkout', checkoutRateLimit, validateBody(checkoutSchema), async (req, res) => {
  try {
    const { name, email, phone, items, address, city, state, landmark, notes } = req.body;
    if (!email || !items || !Array.isArray(items)) {
      return res.status(400).json(apiError('INVALID_CHECKOUT', 'Invalid payload. Need email and items array.'));
    }

    let buyerId: string | undefined;
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session?.user?.id) {
        buyerId = session.user.id;
      }
    } catch {
      // Proceed as guest
    }

    const result = await OrderService.createCheckout(email, items, { name, phone, buyerId, address, city, state, landmark, notes });
    
    res.status(201).json({
      message: 'Order created successfully. Ready for payment.',
      order: result.order
    });
  } catch (error: any) {
    res.status(400).json(apiError('CHECKOUT_FAILED', error instanceof Error ? error.message : 'Unable to create checkout'));
  }
});

ordersRouter.post('/:id/cancel', validateBody(cancelOrderSchema), async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return res.status(400).json(apiError('INVALID_CANCELLATION', 'Email is required to cancel a guest order'));
    const cancelled = await OrderService.cancelPendingOrder(String(req.params.id), email);
    if (!cancelled) return res.status(409).json(apiError('ORDER_NOT_CANCELLABLE', 'Order is not pending payment or does not exist'));
    res.json({ message: 'Order cancelled and stock released' });
  } catch (error) {
    res.status(400).json(apiError('ORDER_CANCELLATION_FAILED', error instanceof Error ? error.message : 'Unable to cancel order'));
  }
});

ordersRouter.post('/lookup', validateBody(guestOrderLookupSchema), async (req, res) => {
  try {
    const { orderNumber, email } = req.body as { orderNumber?: string; email?: string };
    if (!orderNumber || !email) return res.status(400).json(apiError('INVALID_ORDER_LOOKUP', 'Order number and email are required'));
    const order = await OrderService.lookupGuestOrder(orderNumber, email);
    if (!order) return res.status(404).json(apiError('ORDER_NOT_FOUND', 'Order not found'));
    res.json(order);
  } catch (error) {
    res.status(400).json(apiError('ORDER_LOOKUP_FAILED', error instanceof Error ? error.message : 'Unable to look up order'));
  }
});

// NEW: Get Paystack Checkout Link
ordersRouter.post('/:id/pay', async (req, res) => {
  try {
    const paymentData = await OrderService.initializePayment(req.params.id);
    res.json({
      message: 'Payment initialized. Redirect buyer to this URL.',
      paymentData
    });
  } catch (error: any) {
    res.status(400).json(apiError('PAYMENT_INITIALIZATION_FAILED', error instanceof Error ? error.message : 'Unable to initialize payment'));
  }
});

ordersRouter.post('/verify-payment', async (req, res) => {
  try {
    const { reference } = req.body as { reference?: string };
    if (!reference) return res.status(400).json(apiError('INVALID_REFERENCE', 'Payment reference is required'));
    const result = await OrderService.verifyAndConfirmPayment(reference);
    res.json(result);
  } catch (error: any) {
    res.status(400).json(apiError('VERIFICATION_FAILED', error instanceof Error ? error.message : 'Unable to verify payment'));
  }
});
