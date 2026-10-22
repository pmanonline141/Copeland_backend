import { db } from '../db/index.js';
import { auditLog } from '../db/schema/index.js';
export async function recordAuditEvent(event) {
    const [record] = await db.insert(auditLog).values({
        actorId: event.actorId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        details: event.details ?? {},
    }).returning();
    return record;
}
