import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const BUILT_INS = Object.freeze([
  {
    quickReplyId: "BUILTIN_GREETING",
    shortcut: "/hello",
    title: "Greeting",
    text: "Namaste! RX Design Hub se message karne ke liye dhanyavaad. Main aapki kis tarah help kar sakta/sakti hoon?",
    category: "GENERAL"
  },
  {
    quickReplyId: "BUILTIN_CATALOGUE",
    shortcut: "/catalogue",
    title: "Catalogue",
    text: "Zaroor. Aap kis product ka catalogue dekhna chahenge? Product aur approximate quantity share kar dein.",
    category: "SALES"
  },
  {
    quickReplyId: "BUILTIN_PRICE",
    shortcut: "/price",
    title: "Price enquiry",
    text: "Best quotation ke liye product, quantity, size/pages aur delivery city share kar dein.",
    category: "SALES"
  },
  {
    quickReplyId: "BUILTIN_DESIGN",
    shortcut: "/design",
    title: "Design requirements",
    text: "Design start karne ke liye logo, content, preferred colours aur reference sample share kar dein.",
    category: "ORDER"
  },
  {
    quickReplyId: "BUILTIN_PAYMENT",
    shortcut: "/payment",
    title: "Payment help",
    text: "Payment reference ya screenshot share kar dein. Hamari accounts team verify karke update karegi.",
    category: "PAYMENT"
  },
  {
    quickReplyId: "BUILTIN_HUMAN",
    shortcut: "/agent",
    title: "Human assistance",
    text: "Main aapki chat sales executive ko assign kar raha/rahi hoon. Team jaldi connect karegi.",
    category: "SUPPORT"
  }
].map((item) => Object.freeze({ ...item, builtin: true, active: true })));

export class QuickReplyService {
  constructor({ store, audit }) {
    this.store = store;
    this.audit = audit;
  }

  async list(orgId, options = {}) {
    const result = await this.store.find(COLLECTIONS.quickReplies, {
      filters: [["orgId", "==", orgId]],
      limit: Math.min(Number(options.limit) || 100, 100),
      search: options.search,
      searchFields: ["shortcut", "title", "text", "category"]
    });
    const custom = result.items
      .filter((item) => options.includeInactive === true || item.active !== false)
      .map((item) => ({ ...item, builtin: false }));
    const items = [...BUILT_INS, ...custom]
      .filter((item) => !options.search || `${item.shortcut} ${item.title} ${item.text} ${item.category}`.toLowerCase().includes(options.search.toLowerCase()))
      .sort((left, right) => left.category.localeCompare(right.category) || left.shortcut.localeCompare(right.shortcut));
    return { items, pagination: { nextCursor: null, hasMore: false } };
  }

  async create(orgId, input, actor = {}) {
    await this.assertShortcutAvailable(orgId, input.shortcut);
    const quickReplyId = createId("quickReply");
    const timestamp = now();
    const record = {
      quickReplyId,
      orgId,
      shortcut: normalizeShortcut(input.shortcut),
      title: input.title,
      text: input.text,
      category: input.category || "GENERAL",
      active: input.active !== false,
      createdBy: actor.userId || "SYSTEM",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.create(COLLECTIONS.quickReplies, quickReplyId, record);
    await this.audit.write({
      orgId,
      actorType: actor.userId ? "USER" : "SYSTEM",
      actorId: actor.userId || "SYSTEM",
      action: "QUICK_REPLY_CREATED",
      entityType: "QUICK_REPLY",
      entityId: quickReplyId,
      after: record
    });
    return { ...record, builtin: false };
  }

  async update(orgId, quickReplyId, patch, actor = {}) {
    const before = await this.store.get(COLLECTIONS.quickReplies, quickReplyId);
    if (!before || before.orgId !== orgId) throw new NotFoundError("Quick reply");
    const allowed = Object.fromEntries(
      ["shortcut", "title", "text", "category", "active"]
        .filter((field) => patch[field] !== undefined)
        .map((field) => [field, field === "shortcut" ? normalizeShortcut(patch[field]) : patch[field]])
    );
    if (allowed.shortcut && allowed.shortcut !== before.shortcut) {
      await this.assertShortcutAvailable(orgId, allowed.shortcut, quickReplyId);
    }
    allowed.updatedAt = now();
    await this.store.update(COLLECTIONS.quickReplies, quickReplyId, allowed);
    await this.audit.write({
      orgId,
      actorType: actor.userId ? "USER" : "SYSTEM",
      actorId: actor.userId || "SYSTEM",
      action: "QUICK_REPLY_UPDATED",
      entityType: "QUICK_REPLY",
      entityId: quickReplyId,
      before,
      after: allowed
    });
    return { ...before, ...allowed, builtin: false };
  }

  async assertShortcutAvailable(orgId, shortcut, excludeId = null) {
    const normalized = normalizeShortcut(shortcut);
    if (BUILT_INS.some((item) => item.shortcut === normalized)) {
      throw new ConflictError(`Quick reply ${normalized} already exists`);
    }
    const existing = await this.store.find(COLLECTIONS.quickReplies, {
      filters: [["orgId", "==", orgId], ["shortcut", "==", normalized]],
      limit: 2
    });
    if (existing.items.some((item) => (item.quickReplyId || item.id) !== excludeId)) {
      throw new ConflictError(`Quick reply ${normalized} already exists`);
    }
  }
}

function normalizeShortcut(value) {
  return String(value || "").trim().toLowerCase();
}
