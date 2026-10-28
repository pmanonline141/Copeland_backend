import { auth } from './src/auth/auth.js';
import { db } from './src/db/index.js';
import { user } from './src/db/schema/index.js';
import { account } from './src/db/schema/auth.js'; // Import account table
import { eq } from 'drizzle-orm';

async function fixAdmin() {
  try {
    const email = 'admin@test.com';
    const newPassword = 'Password12345!';
    
    const ctx = await auth.$context;
    
    // 1. Find the user
    const userRecord = await ctx.internalAdapter.findUserByEmail(email);
    if (!userRecord || !userRecord.user) {
      console.log('❌ User not found!');
      process.exit(1);
    }

    // 2. Hash the new password
    const hash = await ctx.password.hash(newPassword);
    
    // 3. Update the account table directly
    await db.update(account)
      .set({ password: hash })
      .where(eq(account.userId, userRecord.user.id));

    // 4. Force role to admin and verify email
    await db.update(user)
      .set({ role: 'admin', emailVerified: true })
      .where(eq(user.id, userRecord.user.id));

    console.log(`✅ Success! Admin account updated.`);
    console.log(`Email: ${email}`);
    console.log(`Password: ${newPassword}`);
  } catch (error) {
    console.error('❌ Error:', error);
  }
  process.exit(0);
}
fixAdmin();
