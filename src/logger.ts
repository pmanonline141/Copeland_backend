 import crypto from 'crypto';
import morgan from 'morgan';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

// Pretty output only in local development. Tests, production and Vercel stay on plain JSON.
// Set LOG_PRETTY=false to force JSON locally.
const prettyLogs =
   process.env.NODE_ENV === 'development' &&
  process.env.VERCEL !== '1' &&
  process.env.LOG_PRETTY !== 'false';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    censor: '[REDACTED]',
  },
  ...(prettyLogs && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export const requestLogger = pinoHttp({
  logger,
  autoLogging: false,
  genReqId: (req, res) => {
    const requestedId = req.headers['x-request-id'];
    const id = typeof requestedId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(requestedId)
      ? requestedId
      : crypto.randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      path: req.url?.split('?')[0],
    }),
    res: (res) => ({
      statusCode: res.statusCode,
      contentType: res.getHeader('content-type'),
    }),
  },
  customLogLevel: (_req, res, error) => {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url?.split('?')[0]} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url?.split('?')[0]} ${res.statusCode}`,
  customErrorObject: (_req, res, error, attributes) => ({
    ...attributes,
    err: { type: error.name, message: `HTTP ${res.statusCode}` },
  }),
});

export const morganRequestLogger = morgan((tokens, req, res) => {
  const statusCode = res.statusCode;
  const responseTime = tokens['response-time'](req, res);
  const requestId = res.getHeader('x-request-id');
  const fields = {
    ...(typeof requestId === 'string' ? { requestId } : {}),
    method: req.method,
    path: req.url?.split('?')[0],
    statusCode,
    ...(responseTime ? { responseTimeMs: Number(responseTime) } : {}),
  };
  const message = `${req.method} ${req.url?.split('?')[0]} ${statusCode}`;

  if (statusCode >= 500) logger.error(fields, message);
  else if (statusCode >= 400) logger.warn(fields, message);
  else logger.info(fields, message);

  return undefined;
});

export function errorLogFields(error: unknown) {
  if (!(error instanceof Error)) {
    return { errorName: 'UnknownError', errorMessage: 'A non-Error value was thrown' };
  }

  let cause: unknown = error;
  const visited = new Set<unknown>();
  while (cause instanceof Error && 'cause' in cause && !visited.has(cause)) {
    visited.add(cause);
    cause = cause.cause;
  }
  const diagnostic = cause instanceof Error
    ? cause as Error & {
      code?: unknown;
      column?: unknown;
      constraint?: unknown;
      table?: unknown;
    }
    : undefined;
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(diagnostic && diagnostic !== error ? { causeMessage: diagnostic.message } : {}),
    ...(typeof diagnostic?.code === 'string' ? { databaseErrorCode: diagnostic.code } : {}),
    ...(typeof diagnostic?.table === 'string' ? { databaseTable: diagnostic.table } : {}),
    ...(typeof diagnostic?.column === 'string' ? { databaseColumn: diagnostic.column } : {}),
    ...(typeof diagnostic?.constraint === 'string' ? { databaseConstraint: diagnostic.constraint } : {}),
  };
}