import cors from 'cors';
import express, { ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth/auth.js';
import { logger, requestLogger } from './logger.js';
import { authRateLimit } from './middleware/rate-limits.js';
import { apiError } from './http/responses.js';
import { adminRouter } from './routes/admin.js';
import { ordersRouter } from './routes/orders.js';
import { partnersRouter } from './routes/partners.js';
import { productsRouter } from './routes/products.js';
import { settlementsRouter } from './routes/settlements.js';
import { webhookRouter } from './routes/webhooks.js';

const allowedOrigins = (process.env.FRONTEND_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
export const app = express();

app.use(requestLogger);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true,
}));

app.use('/api/auth', authRateLimit);
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhookRouter);
app.use(express.json({ limit: '1mb' }));

app.use('/api/settlements', settlementsRouter);
app.use('/api/products', productsRouter);
app.use('/api/partners', partnersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  logger.error({ requestId: req.id, errorName }, 'Request failed');
  res.status(500).json(apiError('INTERNAL_ERROR', 'An unexpected error occurred'));
};
app.use(errorHandler);
