import { eq } from 'drizzle-orm';
import { auth } from './src/auth/auth.js';
import { db, pool } from './src/db/index.js';
import { user } from './src/db/schema/index.js';

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.ADMIN_NAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !name || !password || password.length < 12) {
    throw new Error('ADMIN_EMAIL, ADMIN_NAME, and ADMIN_PASSWORD (at least 12 characters) are required');
  }

  let [account] = await db.select().from(user).where(eq(user.email, email));
  if (!account) {
    await auth.api.signUpEmail({ body: { name, email, password } });
    [account] = await db.select().from(user).where(eq(user.email, email));
  }
  if (!account) throw new Error('Better Auth did not create the admin account');

  await db.update(user).set({ role: 'admin', updatedAt: new Date() }).where(eq(user.id, account.id));
  console.info(`Seeded admin account for ${email}`);
}

void seedAdmin()
  .catch((error: unknown) => {
    console.error('Admin seeding failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
