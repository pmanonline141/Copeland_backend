import { db } from './src/db/index';
import { user, partners } from './src/db/schema/index';
import { randomUUID } from 'crypto';

async function seed() {
  console.log('Seeding test users...');
  
  const supplierId = randomUUID();
  const adminId = randomUUID();
  const partnerId = randomUUID();

  // 1. Insert Fake Supplier
  await db.insert(user).values({
    id: supplierId, name: 'Test Supplier', email: 'supplier@test.com', emailVerified: true, role: 'supplier', createdAt: new Date(), updatedAt: new Date()
  });
  
  // 2. Insert Fake Admin
  await db.insert(user).values({
    id: adminId, name: 'Test Admin', email: 'admin@test.com', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date()
  });

  // 3. Insert Fake Partner Profile for Supplier
  await db.insert(partners).values({
    id: partnerId, userId: supplierId, businessName: 'Supplier Clothings', status: 'approved'
  });

  console.log('\n--- COPY THIS PARTNER ID ---');
  console.log(partnerId);
  console.log('----------------------------\n');
  process.exit(0);
}
seed();
