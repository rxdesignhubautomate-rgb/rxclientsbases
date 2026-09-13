import { COLLECTIONS } from "../config/constants.js";
import { resolveClientScope, canAccessRelationship, CLIENT_SCOPES } from "../utils/client-scope.js";

// Read all pages: dashboard counts must never be the size of a limited list.
async function readAll(store, collection, orgId, select) {
  const items = [];
  let cursor;
  for (;;) {
    const result = await store.find(collection, { filters: [["orgId", "==", orgId]], limit: 1000, cursor, select });
    items.push(...result.items);
    if (!result.pagination?.hasMore) return items;
    const next = result.items.at(-1)?.id;
    if (!next || next === cursor) throw new Error("Unable to complete marketing counts");
    cursor = next;
  }
}

export async function marketingOverview(store, orgId, actor = {}) {
  const [contacts, replies] = await Promise.all([
    readAll(store, COLLECTIONS.contacts, orgId, ["contactId", "relationshipType", "assignedTo", "marketingConsent", "marketingOptOut", "optInStatus"]),
    readAll(store, COLLECTIONS.marketingProspects, orgId, ["contactId"])
  ]);
  const scope = resolveClientScope(actor);
  const visible = contacts.filter(contact => actor.role !== "SALES" || (scope === CLIENT_SCOPES.ASSIGNED
    ? Boolean(actor.userId) && contact.assignedTo === actor.userId
    : canAccessRelationship(scope, contact.relationshipType)));
  const visibleIds = new Set(visible.map(contact => contact.contactId || contact.id));
  return {
    totalContacts: visible.length,
    replied: new Set(replies.map(reply => reply.contactId || reply.id).filter(id => visibleIds.has(id))).size,
    optedOut: visible.filter(contact => contact.marketingOptOut === true || contact.marketingConsent?.status === "OPTED_OUT" || contact.optInStatus === "OPTED_OUT").length
  };
}
