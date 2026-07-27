import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now } from "../utils/dates.js";

export class AuditService {
  constructor(store) {
    this.store = store;
  }

  async write({ orgId, actorType = "SYSTEM", actorId = "SYSTEM", action, entityType, entityId, before = {}, after = {}, metadata = {} }) {
    const auditLogId = createId("auditLog");
    return this.store.create(COLLECTIONS.auditLogs, auditLogId, {
      auditLogId,
      orgId,
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      before,
      after,
      metadata,
      createdAt: now()
    });
  }
}
