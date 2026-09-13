import { getDb } from "../firebase.js";
import { messageKey, listChatMessages } from "./chatStore.js";

export const viewerKey = (req, role) =>
  messageKey(`${role}:${req.device?.code || "dashboard"}`).slice(0, 32);
export const userRef = (key) => getDb().collection("chatUsers").doc(key);
export const timestamp = () => new Date().toISOString();
export const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export const cleanPhone = (value) => {
  const phone = String(value || "").replace(/[\s()+-]/g, "");
  if (!/^[1-9]\d{6,14}$/.test(phone))
    throw bad("Enter a full international number, including country code.");
  return phone;
};
export function messageMatches(message, filters = {}) {
  const query = String(filters.q || "")
    .trim()
    .toLocaleLowerCase();
  if (
    query &&
    ![
      message.text,
      message.media?.filename,
      ...(message.contacts || []).map((c) => c.name?.formatted_name),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query)
  )
    return false;
  if (filters.type === "links" && !/https?:\/\/\S+/i.test(message.text || ""))
    return false;
  if (
    filters.type === "media" &&
    !["image", "video", "audio", "sticker"].includes(message.type)
  )
    return false;
  if (
    filters.type &&
    !["all", "links", "media"].includes(filters.type) &&
    message.type !== filters.type
  )
    return false;
  const at = Date.parse(message.timestamp);
  if (filters.from && at < Date.parse(filters.from)) return false;
  if (filters.to && at > Date.parse(filters.to)) return false;
  return true;
}
export async function searchHistory(leadId, filters) {
  if (String(filters.q || "").length > 200)
    throw bad("Search must be 200 characters or fewer.");
  for (const key of ["from", "to"])
    if (filters[key] && !Number.isFinite(Date.parse(filters[key])))
      throw bad("Invalid date filter.");
  if (
    filters.from &&
    filters.to &&
    Date.parse(filters.from) > Date.parse(filters.to)
  )
    throw bad("Start date must be before end date.");
  let cursor = String(filters.cursor || ""),
    scanned = 0,
    messages = [];
  // A bounded scan works for existing history, without silently excluding old unindexed messages.
  do {
    const page = await listChatMessages(leadId, cursor, 100);
    scanned += page.messages.length;
    messages.push(...page.messages.filter((m) => messageMatches(m, filters)));
    cursor = page.nextCursor;
  } while (cursor && scanned < 800 && messages.length < 50);
  return {
    messages: messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    nextCursor: cursor || null,
    scanned,
    complete: !cursor,
  };
}
export async function saveChatView(leadId, key, value) {
  const patch = {};
  if ("favourite" in value) patch.favourite = value.favourite === true;
  if ("muted" in value) patch.muted = value.muted === true;
  if ("labels" in value) {
    if (!Array.isArray(value.labels) || value.labels.length > 15)
      throw bad("Use at most 15 labels.");
    patch.labels = [
      ...new Set(
        value.labels.map((v) => String(v).trim().slice(0, 32)).filter(Boolean),
      ),
    ];
  }
  const ref = getDb().collection("leads").doc(leadId);
  await ref.set(
    { chatViews: { [key]: patch }, updatedAt: timestamp() },
    { merge: true },
  );
  return (await ref.get()).data()?.chatViews?.[key] || {};
}
export function cleanPreferences(body) {
  const result = {};
  if ("theme" in body)
    result.theme = ["light", "dark", "system"].includes(body.theme)
      ? body.theme
      : "light";
  if ("wallpaper" in body)
    result.wallpaper = ["default", "plain", "mint", "blue"].includes(
      body.wallpaper,
    )
      ? body.wallpaper
      : "default";
  if ("fontSize" in body)
    result.fontSize = Math.min(22, Math.max(14, Number(body.fontSize) || 16));
  for (const key of ["notifications", "sound", "typing"])
    if (key in body) result[key] = body[key] === true;
  if ("recentEmoji" in body)
    result.recentEmoji = Array.isArray(body.recentEmoji)
      ? body.recentEmoji.slice(0, 32).map((e) => String(e).slice(0, 24))
      : [];
  return result;
}
