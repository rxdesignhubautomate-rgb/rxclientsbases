import { getContainer } from "../container.js";
import { parseMigrationArgs } from "./lib/migration-runner.js";

const options = parseMigrationArgs();
const c = getContainer();
const input = {
  channelAccountId: c.env.DEFAULT_CHANNEL_ACCOUNT_ID,
  channel: "WHATSAPP",
  provider: "META_CLOUD_API",
  displayName: process.env.CHANNEL_DISPLAY_NAME || "RX Design Hub",
  displayNumber: process.env.CHANNEL_DISPLAY_NUMBER || "",
  phoneNumberId: c.env.META_PHONE_NUMBER_ID,
  businessAccountId: c.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || "",
  status: "ACTIVE",
  sendEnabled: true,
  receiveEnabled: true,
  isDefault: true
};
if (options.dryRun) console.log(JSON.stringify({ dryRun: true, orgId: options.orgId, input }, null, 2));
else {
  await c.store.set("organizations", options.orgId, {
    orgId: options.orgId,
    name: process.env.ORGANIZATION_NAME || "RX Design Hub",
    timezone: c.env.ORG_TIMEZONE,
    currency: c.env.ORG_CURRENCY,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date()
  }, { merge: true });
  const existing = await c.store.get("channelAccounts", input.channelAccountId);
  const result = existing
    ? await c.channelAccounts.update(options.orgId, input.channelAccountId, input)
    : await c.channelAccounts.create(options.orgId, input);
  await c.channelAccounts.makeDefault(options.orgId, input.channelAccountId);
  console.log(JSON.stringify({ success: true, channelAccount: result }, null, 2));
}
