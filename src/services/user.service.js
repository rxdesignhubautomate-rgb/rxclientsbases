import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

export class UserService {
  constructor({ store, audit }) {
    this.store = store;
    this.audit = audit;
  }

  async create(orgId, input, actor = {}) {
    const duplicate = await this.store.find(COLLECTIONS.users, {
      filters: [["firebaseUid", "==", input.firebaseUid]],
      limit: 2
    });
    if (duplicate.items.length) throw new ConflictError("Firebase user is already provisioned");
    const userId = createId("user");
    const user = { userId, orgId, ...input, createdAt: now(), updatedAt: now() };
    await this.store.create(COLLECTIONS.users, userId, user);
    await this.audit.write({ orgId, actorType: "USER", actorId: actor.userId, action: "USER_CREATED", entityType: "USER", entityId: userId, after: { ...user, firebaseUid: "[REDACTED]" } });
    return user;
  }

  async list(orgId, options = {}) {
    const result = await this.store.find(COLLECTIONS.users, {
      filters: [["orgId", "==", orgId]],
      limit: options.limit || 100,
      cursor: options.cursor,
      search: options.search,
      searchFields: ["name", "email", "phone", "role"]
    });
    return {
      ...result,
      items: result.items.sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    };
  }

  async update(orgId, userId, patch, actor = {}) {
    const before = await this.store.get(COLLECTIONS.users, userId);
    if (!before || before.orgId !== orgId) throw new NotFoundError("User");
    const allowed = Object.fromEntries(
      ["name", "email", "phone", "role", "active", "permissions"]
        .filter((field) => patch[field] !== undefined)
        .map((field) => [field, patch[field]])
    );
    allowed.updatedAt = now();
    await this.store.update(COLLECTIONS.users, userId, allowed);
    await this.audit.write({ orgId, actorType: "USER", actorId: actor.userId, action: "USER_PERMISSIONS_CHANGED", entityType: "USER", entityId: userId, before, after: allowed });
    return { ...before, ...allowed };
  }
}

function timestamp(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (Number.isFinite(value._seconds)) return value._seconds * 1000;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}
