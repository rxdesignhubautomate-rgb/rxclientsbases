import { ulid } from "ulid";
import { ID_PREFIXES } from "../config/constants.js";

export function createId(type) {
  const prefix = ID_PREFIXES[type];
  if (!prefix) throw new Error(`Unknown identifier type: ${type}`);
  return `${prefix}_${ulid()}`;
}

export function isPermanentId(value, type) {
  const prefix = ID_PREFIXES[type];
  return Boolean(prefix && new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(String(value || "")));
}
