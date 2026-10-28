import cron from 'node-cron';
import { logger } from '../logger.js';
import { purgeOrphanedUploads } from '../lib/cloudinary.js';

export function startCloudinaryCleanup() {
  // 03:00 every day
  cron.schedule('0 3 * * *', async () => {
    try {
      const removed = await purgeOrphanedUploads(24);
      logger.info({ removed }, 'Cloudinary orphan sweep finished');
    } catch (error) {
      logger.error({ error }, 'Cloudinary orphan sweep failed');
    }
  });
}