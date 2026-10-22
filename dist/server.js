import { sql } from 'drizzle-orm';
import { app } from './app.js';
import { validateEnvironment } from './config/environment.js';
import { db } from './db/index.js';
import { logger } from './logger.js';
import { OrderService } from './services/orders.service.js';
async function startServer() {
    try {
        validateEnvironment();
    }
    catch (error) {
        logger.fatal({
            errorMessage: error instanceof Error ? error.message : 'Environment validation failed',
        }, 'Invalid server configuration');
        process.exitCode = 1;
        return;
    }
    const roleResult = await db.execute(sql `
    SELECT rolsuper OR rolbypassrls AS bypass_rls
    FROM pg_roles
    WHERE rolname = current_user
  `);
    if (!roleResult.rows[0]?.bypass_rls) {
        throw new Error('Application database role must bypass row-level security');
    }
    const port = Number(process.env.PORT ?? 3000);
    const server = app.listen(port, () => logger.info({ port }, 'Copeland API started'));
    server.on('error', (error) => {
        logger.fatal({ errorName: error.name }, 'Unable to start HTTP server');
        process.exitCode = 1;
    });
    setInterval(() => {
        void OrderService.expireUnpaidOrders().catch((error) => {
            logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Failed to expire unpaid orders');
        });
    }, 60_000).unref();
}
void startServer().catch((error) => {
    logger.fatal({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Startup validation failed');
    process.exitCode = 1;
});
