import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorLogFields, logger, morganRequestLogger, requestLogger } from '../src/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error log fields', () => {
  it('includes useful database diagnostics without serializing the full error object', () => {
    const error = Object.assign(new Error('column "expires_at" does not exist'), {
      code: '42703',
      column: 'expires_at',
      table: 'orders',
    });

    expect(errorLogFields(error)).toEqual({
      errorName: 'Error',
      errorMessage: 'column "expires_at" does not exist',
      databaseErrorCode: '42703',
      databaseTable: 'orders',
      databaseColumn: 'expires_at',
    });
  });

  it('does not stringify arbitrary thrown values', () => {
    expect(errorLogFields({ password: 'private' })).toEqual({
      errorName: 'UnknownError',
      errorMessage: 'A non-Error value was thrown',
    });
  });

  it('reports the underlying PostgreSQL cause from a wrapped startup query error', () => {
    const databaseError = Object.assign(new Error('password authentication failed for user "postgres"'), {
      code: '28P01',
    });
    const wrappedError = Object.assign(
      new Error('Failed query: SELECT rolsuper OR rolbypassrls FROM pg_roles'),
      { cause: databaseError },
    );
    const startupError = new Error(
      'Unable to verify application database role. Check DATABASE_URL credentials and database connectivity.',
      { cause: wrappedError },
    );

    expect(errorLogFields(startupError)).toEqual({
      errorName: 'Error',
      errorMessage: 'Unable to verify application database role. Check DATABASE_URL credentials and database connectivity.',
      causeMessage: 'password authentication failed for user "postgres"',
      databaseErrorCode: '28P01',
    });
  });

  it('logs Morgan HTTP errors with the request id but not query parameters', async () => {
    const errorLog = vi.spyOn(logger, 'error');
    const app = express();
    app.use(requestLogger);
    app.use(morganRequestLogger);
    app.get('/failure', (_req, res) => res.status(500).end());

    await request(app).get('/failure?token=do-not-log');

    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        method: 'GET',
        path: '/failure',
        statusCode: 500,
      }),
      'GET /failure 500',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('do-not-log');
  });

  it('logs successful Morgan requests at info level', async () => {
    const infoLog = vi.spyOn(logger, 'info');
    const app = express();
    app.use(requestLogger);
    app.use(morganRequestLogger);
    app.get('/health', (_req, res) => res.status(200).end());

    await request(app).get('/health');

    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/health', statusCode: 200 }),
      'GET /health 200',
    );
  });
});
