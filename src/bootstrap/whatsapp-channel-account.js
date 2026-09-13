import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";

export async function ensureWhatsAppChannelAccount(container, actor = {}) {
  const { env, store, channelAccounts } = container;
  try {
    return {
      account: await channelAccounts.resolveForSend(env.ORG_ID, "WHATSAPP", null),
      changed: false
    };
  } catch (error) {
    if (error.code !== "CONFLICT") throw error;
  }

  const timestamp = now();
  const existingOrganization = await store.get(COLLECTIONS.organizations, env.ORG_ID);
  await store.set(COLLECTIONS.organizations, env.ORG_ID, {
    orgId: env.ORG_ID,
    name: process.env.ORGANIZATION_NAME || "RX Design Hub",
    timezone: env.ORG_TIMEZONE,
    currency: env.ORG_CURRENCY,
    active: true,
    createdAt: existingOrganization?.createdAt || timestamp,
    updatedAt: timestamp
  }, { merge: true });

  return channelAccounts.ensureConfiguredDefault(env.ORG_ID, {
    channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    channel: "WHATSAPP",
    provider: "META_CLOUD_API",
    displayName: process.env.CHANNEL_DISPLAY_NAME || "RX Design Hub",
    displayNumber: process.env.CHANNEL_DISPLAY_NUMBER || "",
    phoneNumberId: env.META_PHONE_NUMBER_ID,
    businessAccountId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || "",
    status: "ACTIVE",
    sendEnabled: true,
    receiveEnabled: true,
    isDefault: true
  }, actor);
}
