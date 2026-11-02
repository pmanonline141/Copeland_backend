import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';

async function test() {
  try {
    console.log('Testing DB connection...');
    console.log('DATABASE_URL:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@'));
    const result = await db.execute(sql`SELECT 1`);
    console.log('DB Connection Successful:', result);
    process.exit(0);
  } catch (err) {
    console.error('DB Connection Failed:', err);
    process.exit(1);
  }
}

test();
