import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const PUBLIC_FIELDS = [
  "channelAccountId",
  "channel",
  "provider",
  "displayName",
  "displayNumber",
  "phoneNumberId",
  "businessAccountId",
  "status",
  "sendEnabled",
  "receiveEnabled",
  "isDefault"
];

export class ChannelAccountService {
  constructor({ store, audit }) {
    this.store = store;
    this.audit = audit;
  }

  async create(orgId, input, actor = {}) {
    const existing = await this.store.get(COLLECTIONS.channelAccounts, input.channelAccountId);
    if (existing) throw new ConflictError("Channel account ID already exists");
    const timestamp = now();
    const account = { ...pick(input, PUBLIC_FIELDS), orgId, createdAt: timestamp, updatedAt: timestamp };
    await this.store.create(COLLECTIONS.channelAccounts, input.channelAccountId, account);
    if (account.isDefault) await this.makeDefault(orgId, input.channelAccountId, actor);
    await this.audit.write(auditInput(actor, orgId, "CHANNEL_ACCOUNT_CREATED", input.channelAccountId, {}, account));
    return this.get(orgId, input.channelAccountId);
  }

  async get(orgId, id) {
    const account = await this.store.get(COLLECTIONS.channelAccounts, id);
    if (!account || account.orgId !== orgId) throw new NotFoundError("Channel account");
    return account;
  }

  list(orgId, options = {}) {
    const filters = [["orgId", "==", orgId]];
    if (options.channel) filters.push(["channel", "==", options.channel]);
    if (options.status) filters.push(["status", "==", options.status]);
    return this.store.find(COLLECTIONS.channelAccounts, {
      filters,
      orderBy: ["createdAt", "desc"],
      limit: options.limit || 100,
      cursor: options.cursor
    });
  }

  async update(orgId, id, input, actor = {}) {
    const before = await this.get(orgId, id);
    const patch = pick(input, PUBLIC_FIELDS.filter((field) => !["channelAccountId", "isDefault"].includes(field)));
    patch.updatedAt = now();
    await this.store.update(COLLECTIONS.channelAccounts, id, patch);
    await this.audit.write(auditInput(actor, orgId, "CHANNEL_ACCOUNT_UPDATED", id, before, patch));
    return this.get(orgId, id);
  }

  async activate(orgId, id, actor = {}) {
    const before = await this.get(orgId, id);
    const patch = { status: "ACTIVE", receiveEnabled: true, updatedAt: now() };
    await this.store.update(COLLECTIONS.channelAccounts, id, patch);
    await this.audit.write(auditInput(actor, orgId, "CHANNEL_ACCOUNT_ACTIVATED", id, before, patch));
    return this.get(orgId, id);
  }

  async disable(orgId, id, actor = {}) {
    const before = await this.get(orgId, id);
    const patch = { status: "DISABLED", sendEnabled: false, receiveEnabled: false, isDefault: false, updatedAt: now() };
    await this.store.update(COLLECTIONS.channelAccounts, id, patch);
    await this.audit.write(auditInput(actor, orgId, "CHANNEL_ACCOUNT_DISABLED", id, before, patch));
    return this.get(orgId, id);
  }

  async makeDefault(orgId, id, actor = {}) {
    const target = await this.get(orgId, id);
    if (target.status !== "ACTIVE" || target.sendEnabled !== true) {
      throw new ConflictError("Default channel account must be active and send-enabled");
    }
    const accounts = await this.list(orgId, { channel: target.channel, limit: 100 });
    await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.channelAccounts, id);
      if (!current || current.status !== "ACTIVE" || current.sendEnabled !== true) {
        throw new ConflictError("Channel account changed and cannot be made default");
      }
      for (const account of accounts.items) {
        tx.update(COLLECTIONS.channelAccounts, account.channelAccountId || account.id, {
          isDefault: (account.channelAccountId || account.id) === id,
          updatedAt: now()
        });
      }
    });
    await this.audit.write(auditInput(actor, orgId, "CHANNEL_ACCOUNT_MADE_DEFAULT", id, {}, { channel: target.channel }));
    return this.get(orgId, id);
  }

  async resolveInbound(orgId, phoneNumberId) {
    const result = await this.store.find(COLLECTIONS.channelAccounts, {
      filters: [["orgId", "==", orgId], ["phoneNumberId", "==", phoneNumberId]],
      limit: 2
    });
    const account = result.items[0];
    if (!account) throw new NotFoundError("Inbound channel account");
    return account;
  }

  async resolveForSend(orgId, channel, requestedId = null) {
    if (requestedId) {
      const requested = await this.get(orgId, requestedId);
      if (requested.channel === channel && requested.status === "ACTIVE" && requested.sendEnabled === true) return requested;
    }
    const result = await this.store.find(COLLECTIONS.channelAccounts, {
      filters: [["orgId", "==", orgId], ["channel", "==", channel], ["isDefault", "==", true]],
      limit: 2
    });
    const account = result.items.find((item) => item.status === "ACTIVE" && item.sendEnabled === true);
    if (!account) throw new ConflictError(`No active default ${channel} account is available`);
    return account;
  }
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
}

function auditInput(actor, orgId, action, entityId, before, after) {
  return { orgId, actorType: actor.userId ? "USER" : "SYSTEM", actorId: actor.userId || "SYSTEM", action, entityType: "CHANNEL_ACCOUNT", entityId, before, after };
}
