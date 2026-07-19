import { COLLECTIONS, LEAD_STATUSES } from "../config/constants.js";
import { now } from "../utils/dates.js";

export class DashboardService {
  constructor(store) {
    this.store = store;
  }

  async summary(orgId) {
    const [contacts, openConversations, leads, dueFollowUps, activeOrders] = await Promise.all([
      this._items(COLLECTIONS.contacts, orgId, [], 1000),
      this._items(COLLECTIONS.conversations, orgId, [["status", "==", "OPEN"]], 1000),
      this._items(COLLECTIONS.leads, orgId, [], 1000),
      this._items(COLLECTIONS.followUps, orgId, [["status", "==", "SCHEDULED"], ["dueAt", "<=", now()]], 500),
      this._items(COLLECTIONS.orders, orgId, [["status", "not-in", ["CANCELLED", "COMPLETED"]]], 500)
    ]);
    return {
      contacts: contacts.length,
      openConversations: openConversations.length,
      unreadMessages: openConversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0),
      activeLeads: leads.filter((lead) => !["CLOSED_WON", "CLOSED_LOST"].includes(lead.leadStatus)).length,
      dueFollowUps: dueFollowUps.length,
      activeOrders: activeOrders.length
    };
  }

  async pipeline(orgId) {
    const leads = await this._items(COLLECTIONS.leads, orgId, [], 2000);
    return LEAD_STATUSES.map((status) => ({
      status,
      count: leads.filter((lead) => lead.leadStatus === status).length,
      amount: leads.filter((lead) => lead.leadStatus === status).reduce((sum, lead) => sum + Number(lead.orderAmount || 0), 0)
    }));
  }

  async followUps(orgId, assignedTo = null) {
    const filters = [["status", "==", "SCHEDULED"]];
    if (assignedTo) filters.push(["assignedTo", "==", assignedTo]);
    return this.store.find(COLLECTIONS.followUps, {
      filters: [["orgId", "==", orgId], ...filters],
      orderBy: ["dueAt", "asc"],
      limit: 100
    });
  }

  async salesPerformance(orgId) {
    const leads = await this._items(COLLECTIONS.leads, orgId, [], 3000);
    const grouped = new Map();
    for (const lead of leads) {
      const key = lead.assignedTo || "UNASSIGNED";
      const entry = grouped.get(key) || { assignedTo: key, total: 0, won: 0, lost: 0, open: 0, orderAmount: 0 };
      entry.total += 1;
      if (lead.leadStatus === "CLOSED_WON") entry.won += 1;
      else if (lead.leadStatus === "CLOSED_LOST") entry.lost += 1;
      else entry.open += 1;
      entry.orderAmount += Number(lead.orderAmount || 0);
      grouped.set(key, entry);
    }
    return [...grouped.values()].map((entry) => ({
      ...entry,
      conversionRate: entry.total ? Math.round((entry.won / entry.total) * 10000) / 100 : 0
    }));
  }

  async unreadCounts(orgId) {
    const conversations = await this._items(COLLECTIONS.conversations, orgId, [["unreadCount", ">", 0]], 1000);
    return {
      total: conversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0),
      conversations: conversations.map((item) => ({ conversationId: item.conversationId, unreadCount: item.unreadCount }))
    };
  }

  async _items(collection, orgId, filters, limit) {
    const result = await this.store.find(collection, { filters: [["orgId", "==", orgId], ...filters], limit });
    return result.items;
  }
}
