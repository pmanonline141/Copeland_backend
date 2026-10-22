import rateLimit from 'express-rate-limit';

function limiter(limit: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
      },
    },
  });
}

export const authRateLimit = limiter(30, 15 * 60 * 1000);
export const applicationRateLimit = limiter(5, 60 * 60 * 1000);
export const checkoutRateLimit = limiter(10, 15 * 60 * 1000);
export const webhookRateLimit = limiter(600, 60 * 60 * 1000);
