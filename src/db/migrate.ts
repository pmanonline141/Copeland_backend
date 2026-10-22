import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

async function runMigration() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for migrations');
  const migrationUrl = new URL(connectionString);
  if (migrationUrl.hostname.includes('pooler')) {
    throw new Error('Migrations require the direct Postgres connection, not the pooler');
  }
  if (migrationUrl.hostname.endsWith('.supabase.co') && migrationUrl.port !== '5432') {
    throw new Error('The Supabase direct migration connection must use port 5432');
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    console.info('Database migrations completed');
  } finally {
    await pool.end();
  }
}

void runMigration().catch((error: unknown) => {
  console.error('Database migration failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
