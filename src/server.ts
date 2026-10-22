import { sql } from 'drizzle-orm';
import { app } from './app.js';
import { validateEnvironment } from './config/environment.js';
import { db } from './db/index.js';
import { errorLogFields, logger } from './logger.js';
import { OrderService } from './services/orders.service.js';

async function startServer() {
  try {
    validateEnvironment();
  } catch (error) {
    logger.fatal({
      errorMessage: error instanceof Error ? error.message : 'Environment validation failed',
    }, 'Invalid server configuration');
    process.exitCode = 1;
    return;
  }
  let roleResult;
  try {
    roleResult = await db.execute(sql<{ bypass_rls: boolean }>`
      SELECT rolsuper OR rolbypassrls AS bypass_rls
      FROM pg_roles
      WHERE rolname = current_user
    `);
  } catch (error) {
    throw new Error(
      'Unable to verify application database role. Check DATABASE_URL credentials and database connectivity.',
      { cause: error },
    );
  }
  if (!roleResult.rows[0]?.bypass_rls) {
    throw new Error('Application database role must bypass row-level security');
  }

  const schemaResult = await db.execute(sql`
    SELECT
      array_to_string(ARRAY(
        SELECT required.table_name
        FROM (VALUES
          ('partners'),
          ('partner_documents'),
          ('products'),
          ('product_inventory'),
          ('moderation_records'),
          ('orders'),
          ('order_items'),
          ('payments'),
          ('payouts'),
          ('payout_items'),
          ('ledger_entries'),
          ('webhook_events'),
          ('audit_log'),
          ('rfq_requests'),
          ('shipments'),
          ('shipment_updates')
        ) AS required(table_name)
        WHERE to_regclass('public.' || required.table_name) IS NULL
      ), ',') AS missing_tables,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'orders'
          AND column_name = 'expires_at'
      ) AS has_order_expiry,
      array_to_string(ARRAY(
        SELECT required.table_name || '.' || required.column_name
        FROM (VALUES
          ('order_items', 'commission_rate_bps'),
          ('order_items', 'commission_amount_kobo'),
          ('products', 'is_copeland_label')
        ) AS required(table_name, column_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND information_schema.columns.table_name = required.table_name
            AND information_schema.columns.column_name = required.column_name
        )
      ), ',') AS missing_columns
  `);
  const schemaStatus = schemaResult.rows[0] as {
    missing_tables?: unknown;
    has_order_expiry?: unknown;
    missing_columns?: unknown;
  } | undefined;
  const missingTables = typeof schemaStatus?.missing_tables === 'string'
    ? schemaStatus.missing_tables.split(',').filter(Boolean)
    : [];
  const missingColumns = typeof schemaStatus?.missing_columns === 'string'
    ? schemaStatus.missing_columns.split(',').filter(Boolean)
    : [];
  const hasOrderExpiry = schemaStatus?.has_order_expiry === true;
  if (missingTables.length > 0 || missingColumns.length > 0 || !hasOrderExpiry) {
    const missingObjects = [
      ...missingTables,
      ...missingColumns,
      ...(!hasOrderExpiry ? ['orders.expires_at'] : []),
    ];
    throw new Error(
      `Database schema is missing ${missingObjects.join(', ')}. Apply pending migrations using npm run db:migrate.`,
    );
  }

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port);
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.fatal({
      ...errorLogFields(error),
      ...(error.code ? { errorCode: error.code } : {}),
      ...(error.syscall ? { syscall: error.syscall } : {}),
      ...('address' in error && typeof error.address === 'string' ? { address: error.address } : {}),
      ...('port' in error && typeof error.port === 'number' ? { port: error.port } : {}),
    }, 'Unable to start HTTP server');
    process.exitCode = 1;
  });

  server.once('listening', () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    logger.info({ port: listeningPort }, 'Copeland API started');
    setInterval(() => {
      void OrderService.expireUnpaidOrders().catch((error: unknown) => {
        logger.error(errorLogFields(error), 'Failed to expire unpaid orders');
      });
    }, 60_000).unref();
  });
}

// Only run standalone startServer if not imported as a serverless function handler
if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'test') {
  void startServer().catch((error: unknown) => {
    logger.fatal(errorLogFields(error), 'Startup validation failed');
    process.exitCode = 1;
  });
}

export default app;