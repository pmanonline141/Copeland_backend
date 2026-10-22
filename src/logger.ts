import crypto from 'crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    censor: '[REDACTED]',
  },
});

export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const requestedId = req.headers['x-request-id'];
    const id = typeof requestedId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(requestedId)
      ? requestedId
      : crypto.randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
