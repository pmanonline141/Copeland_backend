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
export const uploadSignRateLimit = rateLimit({ windowMs: 60_000, limit: 30 });
export const authRateLimit = limiter(30, 15 * 60 * 1000);
// export const applicationRateLimit = limiter(5, 60 * 60 * 1000);
// DEV OVERRIDE: Increased from 5 to 1000 to allow rapid testing and uploading without getting blocked.
// TODO: Change back to 5 (or a reasonable limit) before going to production.
export const applicationRateLimit = limiter(1000, 60 * 60 * 1000); 
export const checkoutRateLimit = limiter(10, 15 * 60 * 1000);
export const webhookRateLimit = limiter(600, 60 * 60 * 1000);
