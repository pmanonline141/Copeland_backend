import { eq, inArray } from 'drizzle-orm';
import { auth } from './src/auth/auth.js';
import { roles, type Role } from './src/auth/roles.js';
import { db, pool } from './src/db/index.js';
import { user } from './src/db/schema/index.js';

const seedAccounts: Array<{ role: Role; name: string; email: string | undefined }> = [
  { role: 'admin', name: 'Peterson Zoconis', email: process.env.SEED_ADMIN_EMAIL },
  { role: 'staff', name: 'Peterson Zoconis 1', email: process.env.SEED_STAFF_EMAIL },
  { role: 'supplier', name: 'Peterson Zoconis 3', email: process.env.SEED_SUPPLIER_EMAIL },
  { role: 'shipping', name: 'Peterson Zoconis 4', email: process.env.SEED_SHIPPING_EMAIL },
  { role: 'buyer', name: 'Peterson Zoconis 6', email: process.env.SEED_BUYER_EMAIL },
];

async function seedRoleAccounts() {
  const password = process.env.ROLE_ACCOUNT_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('ROLE_ACCOUNT_PASSWORD must be set and at least 12 characters');
  }
  if (process.env.NODE_ENV !== 'production' && process.env.RESEND_SEND_IN_DEVELOPMENT !== 'true') {
    throw new Error('Set RESEND_SEND_IN_DEVELOPMENT=true to deliver verification emails while seeding accounts');
  }
  if (!process.env.RESEND_API_KEY?.trim() || !process.env.RESEND_FROM_EMAIL?.trim()) {
    throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL are required to deliver account emails');
  }

  const emails = seedAccounts.map(({ role, email }) => {
    const normalized = email?.trim().toLowerCase();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error(`A valid SEED_${role.toUpperCase()}_EMAIL is required`);
    }
    return normalized;
  });
  if (new Set(emails).size !== roles.length) throw new Error('Each seeded role must have a unique email address');

  const existing = await db.select({ email: user.email }).from(user).where(inArray(user.email, emails));
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite existing account(s): ${existing.map(({ email }) => email).join(', ')}`);
  }

  for (let index = 0; index < seedAccounts.length; index += 1) {
    const account = seedAccounts[index];
    const email = emails[index];
    await auth.api.signUpEmail({ body: { name: account.name, email, password } });

    const [created] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!created) throw new Error(`Better Auth did not create the ${account.role} account`);
    await db.update(user)
      .set({ role: account.role, updatedAt: new Date() })
      .where(eq(user.id, created.id));
    console.info(`Created ${account.role} account for ${email}`);
  }

  console.info('Role accounts are pending email verification. Supplier and shipping access additionally requires an approved partner application.');
}

void seedRoleAccounts()
  .catch((error: unknown) => {
    console.error('Role-account seeding failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
