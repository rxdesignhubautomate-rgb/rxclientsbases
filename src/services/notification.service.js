import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now } from "../utils/dates.js";

export class NotificationService {
  constructor(store) {
    this.store = store;
  }

  async create(orgId, input) {
    const notificationId = createId("notification");
    return this.store.create(COLLECTIONS.notifications, notificationId, {
      notificationId,
      orgId,
      type: input.type || "SYSTEM",
      severity: input.severity || "INFO",
      title: input.title,
      message: input.message || "",
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      metadata: input.metadata || {},
      status: "UNREAD",
      createdAt: now(),
      updatedAt: now()
    });
  }
}
