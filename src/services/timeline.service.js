import { COLLECTIONS } from "../config/constants.js";
import { toDate } from "../utils/dates.js";

const SOURCES = [
  [COLLECTIONS.messages, "MESSAGE", "createdAt"],
  [COLLECTIONS.leads, "LEAD", "updatedAt"],
  [COLLECTIONS.followUps, "FOLLOW_UP", "updatedAt"],
  [COLLECTIONS.quotations, "QUOTATION", "updatedAt"],
  [COLLECTIONS.orders, "ORDER", "updatedAt"],
  [COLLECTIONS.payments, "PAYMENT", "createdAt"],
  [COLLECTIONS.auditLogs, "AUDIT", "createdAt"]
];

export class TimelineService {
  constructor(store) {
    this.store = store;
  }

  async forContact(orgId, contactId, limit = 100) {
    const events = [];
    for (const [collection, type, timestampField] of SOURCES) {
      const filters = [["orgId", "==", orgId]];
      if (collection === COLLECTIONS.auditLogs) {
        filters.push(["entityId", "==", contactId]);
      } else {
        filters.push(["contactId", "==", contactId]);
      }
      const result = await this.store.find(collection, {
        filters,
        orderBy: [timestampField, "desc"],
        limit: Math.min(limit, 100)
      });
      events.push(...result.items.map((item) => normalizeEvent(type, item, timestampField)));
    }
    return events
      .filter((event) => event.timestamp)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async forEntity(orgId, entityType, entityId, contactId, limit = 100) {
    const timeline = await this.forContact(orgId, contactId, limit * 2);
    return timeline
      .filter((event) => event.entityId === entityId || event.data?.[`${entityType.toLowerCase()}Id`] === entityId)
      .slice(0, limit);
  }
}

function normalizeEvent(type, item, timestampField) {
  return {
    eventType: type,
    entityId: item.messageId || item.leadId || item.followUpId || item.quotationId || item.orderId || item.paymentId || item.auditLogId || item.id,
    timestamp: toDate(item[timestampField]),
    channel: item.channel || null,
    direction: item.direction || null,
    title: titleFor(type, item),
    data: item
  };
}

function titleFor(type, item) {
  if (type === "MESSAGE") return `${item.direction || "INTERNAL"} ${item.type || "MESSAGE"}`;
  if (type === "AUDIT") return item.action || "Activity";
  return `${type.replaceAll("_", " ")} ${item.status || item.leadStatus || "UPDATED"}`;
}
