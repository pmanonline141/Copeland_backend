import { db } from './src/db/index';
import { user } from './src/db/schema/index';
import { eq } from 'drizzle-orm';

async function makeSupplier() {
  await db.update(user)
    .set({ role: 'supplier' })
    .where(eq(user.email, 'jude@copeland.africa'));
  console.log('✅ Jude is now a Supplier again!');
  process.exit(0);
}
makeSupplier();
