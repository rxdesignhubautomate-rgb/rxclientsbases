import { config } from "../config.js";
import { getDb } from "../firebase.js";
import { listLeads } from "./leadStore.js";
import { sendWhatsAppText } from "./whatsapp.js";

const IST_OFFSET_MINUTES = 330;
const DIGEST_SETTINGS_DOC = "digests";

function repNames() {
  const team = config.salesTeam.length ? config.salesTeam : ["ankit", "reshu", "shubham"];
  const names = {};
  for (const member of team) {
    names[member] = member.charAt(0).toUpperCase() + member.slice(1);
  }
  return names;
}

let digestHandle = null;
let digestRunning = false;

export function startDigestScheduler() {
  if (!config.digestEnabled || digestHandle) return;

  digestHandle = setInterval(() => {
    runDueDigests().catch((error) => {
      console.error("digest_scheduler_failed", { error: error.message });
    });
  }, 60 * 1000);
}

export async function runDueDigests() {
  if (digestRunning) return { skipped: true, reason: "already_running" };
  digestRunning = true;

  try {
    const now = istNow();
    const timeKey = istTimeKey(now);
    const dateKey = istDateKey(now);
    const state = await getDigestState();

    if (timeKey >= config.morningDigestTime && state.lastMorningDate !== dateKey) {
      await saveDigestState({ lastMorningDate: dateKey });
      await sendMorningDigests();
    }

    if (timeKey >= config.eveningDigestTime && state.lastEveningDate !== dateKey) {
      await saveDigestState({ lastEveningDate: dateKey });
      await sendEveningManagerDigest();
    }

    return { ok: true };
  } finally {
    digestRunning = false;
  }
}

async function sendMorningDigests() {
  const leads = await listLeads({ limit: 5000 });
  const names = repNames();

  for (const assignee of Object.keys(names)) {
    const phone = config.alertNumbers[assignee];
    if (!phone) continue;

    const repLeads = leads.filter((lead) => normalizeAssignee(lead.assignedTo) === assignee && !isClosed(lead));
    const overdue = repLeads.filter((lead) => followUpBucket(lead) === "overdue");
    const dueToday = repLeads.filter((lead) => followUpBucket(lead) === "due_today");
    const hotOpen = repLeads.filter((lead) => (lead.temperature || "cold") === "hot");

    const message = buildMorningMessage({
      name: names[assignee],
      overdue,
      dueToday,
      hotOpen
    });

    try {
      await sendWhatsAppText(phone, message);
    } catch (error) {
      console.error("morning_digest_send_failed", { assignee, error: error.message });
    }
  }
}

async function sendEveningManagerDigest() {
  const phone = config.alertNumbers.admin;
  if (!phone) return;

  const leads = await listLeads({ limit: 5000 });
  const todayKey = istDateKey(istNow());

  const newToday = leads.filter((lead) => istDateKeyOf(lead.createdAt) === todayKey);
  const hotToday = newToday.filter((lead) => (lead.temperature || "cold") === "hot");
  const warmToday = newToday.filter((lead) => (lead.temperature || "cold") === "warm");
  const coldToday = newToday.filter((lead) => (lead.temperature || "cold") === "cold");
  const convertedToday = leads.filter(
    (lead) => lead.status === "converted" && istDateKeyOf(lead.updatedAt) === todayKey
  );
  const lostToday = leads.filter(
    (lead) => lead.status === "lost" && istDateKeyOf(lead.updatedAt) === todayKey
  );
  const hotPending = leads.filter(
    (lead) => (lead.temperature || "cold") === "hot"
      && !isClosed(lead)
      && (lead.callStatus || "not_called") === "not_called"
  );
  const overdueAll = leads.filter((lead) => !isClosed(lead) && followUpBucket(lead) === "overdue");

  const lostReasons = lostToday
    .map((lead) => lead.lostReason)
    .filter(Boolean);

  const lines = [
    `📊 RX SALES REPORT — ${formatIstDate(istNow())}`,
    "",
    `🆕 New leads today: ${newToday.length}`,
    `🔥 Hot: ${hotToday.length} | 🌤 Warm: ${warmToday.length} | ❄️ Cold: ${coldToday.length}`,
    "",
    `✅ Converted today: ${convertedToday.length}`,
    `❌ Lost today: ${lostToday.length}${lostReasons.length ? ` (${lostReasons.join(", ")})` : ""}`,
    "",
    `⚠️ Hot leads not called yet: ${hotPending.length}`,
    `🔴 Total overdue follow-ups: ${overdueAll.length}`
  ];

  lines.push("", "👥 TEAM EFFICIENCY (owned pipeline):");
  for (const [member, name] of Object.entries(repNames())) {
    const owned = leads.filter((lead) => normalizeAssignee(lead.assignedTo) === member);
    const converted = owned.filter((lead) => lead.status === "converted").length;
    const lost = owned.filter((lead) => lead.status === "lost").length;
    const open = owned.filter((lead) => !isClosed(lead)).length;
    const overdue = owned.filter((lead) => !isClosed(lead) && followUpBucket(lead) === "overdue").length;
    const wonTodayCount = owned.filter((lead) => lead.status === "converted" && istDateKeyOf(lead.updatedAt) === todayKey).length;
    const decided = converted + lost;
    const rate = decided > 0 ? Math.round((converted / decided) * 100) : 0;
    lines.push(
      `• ${name}: ${owned.length} leads | ${open} open | ✅${converted} (today +${wonTodayCount}) | ❌${lost} | Win ${rate}% | 🔴${overdue} overdue`
    );
  }

  if (hotPending.length) {
    lines.push("", "Hot pending:");
    for (const lead of hotPending.slice(0, 5)) {
      lines.push(`• ${lead.name || lead.phone} — ${(lead.requirement || "requirement pending").slice(0, 50)}`);
    }
  }

  try {
    await sendWhatsAppText(phone, lines.join("\n"));
  } catch (error) {
    console.error("evening_digest_send_failed", { error: error.message });
  }
}

function buildMorningMessage({ name, overdue, dueToday, hotOpen }) {
  const lines = [
    `☀️ Good Morning ${name}!`,
    "",
    "Aaj ka sales plan:",
    `🔴 Overdue follow-ups: ${overdue.length}`,
    `📅 Due today: ${dueToday.length}`,
    `🔥 Hot open leads: ${hotOpen.length}`
  ];

  const priority = [...overdue, ...dueToday, ...hotOpen]
    .filter((lead, index, list) => list.findIndex((item) => item.id === lead.id) === index)
    .slice(0, 5);

  if (priority.length) {
    lines.push("", "Top priority:");
    priority.forEach((lead, index) => {
      lines.push(`${index + 1}. ${lead.name || lead.phone} — ${(lead.requirement || "requirement pending").slice(0, 45)}`);
    });
  }

  lines.push("", "Pehle overdue, phir hot leads. Full beast mode! 💪");

  return lines.join("\n");
}

function followUpBucket(lead) {
  if (!lead.followUpAt) return "none";
  const followUp = new Date(lead.followUpAt);
  if (Number.isNaN(followUp.getTime())) return "none";

  const followUpKey = istDateKeyOf(lead.followUpAt);
  const todayKey = istDateKey(istNow());

  if (followUpKey < todayKey) return "overdue";
  if (followUpKey === todayKey) return "due_today";
  return "future";
}

function isClosed(lead) {
  return ["converted", "lost"].includes(lead.status || "");
}

function normalizeAssignee(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pinky") return "ankit";
  return normalized;
}

async function getDigestState() {
  try {
    const db = getDb();
    const snap = await db.collection("settings").doc(DIGEST_SETTINGS_DOC).get();
    return snap.exists ? snap.data() : {};
  } catch (error) {
    console.error("digest_state_read_failed", { error: error.message });
    return {};
  }
}

async function saveDigestState(patch) {
  const db = getDb();
  await db.collection("settings").doc(DIGEST_SETTINGS_DOC).set(patch, { merge: true });
}

function istNow() {
  return new Date(Date.now() + IST_OFFSET_MINUTES * 60 * 1000);
}

function istDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function istTimeKey(date) {
  return date.toISOString().slice(11, 16);
}

function istDateKeyOf(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return istDateKey(new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000));
}

function formatIstDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}
