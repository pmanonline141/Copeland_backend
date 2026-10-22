import { RequestHandler } from 'express';
import { ZodType } from 'zod';
import { apiError } from '../http/responses.js';

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ...apiError('VALIDATION_ERROR', 'Request body is invalid', parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }))),
      });
    }
    req.body = parsed.data;
    next();
  };
}
