import { config } from "../config.js";
import { FieldValue, getDb } from "../firebase.js";
import { nowIso } from "../utils/time.js";

const LEADS = "leads";
const MESSAGES = "messages";
const SALES_USERS = "salesUsers";
const SETTINGS = "settings";
const ASSIGNMENT_DOC = "assignment";

function salesTeam() {
  return config.salesTeam.length ? config.salesTeam : ["ankit", "reshu", "shubham"];
}

// Round-robin: hands out the next salesperson in rotation using an atomic counter,
// so leads distribute equally regardless of temperature.
export async function getNextRoundRobinAssignee() {
  const team = salesTeam();
  const db = getDb();
  const ref = db.collection(SETTINGS).doc(ASSIGNMENT_DOC);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const counter = snap.exists ? Number(snap.data().counter || 0) : 0;
      const assignee = team[counter % team.length];
      tx.set(ref, { counter: counter + 1, updatedAt: nowIso() }, { merge: true });
      return assignee;
    });
  } catch (error) {
    console.error("round_robin_assign_failed", { error: error.message });
    return team[Math.floor(Math.random() * team.length)];
  }
}

export async function findOrCreateLeadByPhone(phone) {
  const db = getDb();
  const ref = db.collection(LEADS).doc(phone);
  const snap = await ref.get();

  if (snap.exists) {
    return { id: ref.id, ...snap.data() };
  }

  const assignedTo = await getNextRoundRobinAssignee();
  const lead = {
    phone,
    name: null,
    requirement: null,
    city: null,
    budget: null,
    urgency: null,
    temperature: "cold",
    status: "new",
    assignedTo,
    aiEnabled: true,
    leadSummary: "New WhatsApp lead. Requirement is not clear yet.",
    source: "whatsapp",
    callStatus: "not_called",
    followUpAt: null,
    followUpReason: null,
    reminderStatus: "none",
    nextAction: null,
    salesNote: null,
    lostReason: null,
    leadScore: 0,
    lastHotAlertAt: null,
    lastHumanTouchAt: null,
    lastHumanAckAt: null,
    messageCount: 0,
    lastInboundAt: nowIso(),
    sequenceStatus: "none",
    activeSequenceProduct: null,
    sequenceStepIndex: 0,
    nextSequenceAt: null,
    lastSequenceSentAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastMessageAt: nowIso()
  };

  await ref.set(lead);
  invalidateLeadListCache();
  return { id: ref.id, ...lead };
}

export async function hasMessage(whatsappMessageId) {
  if (!whatsappMessageId) return false;

  const db = getDb();
  const snap = await db
    .collection(MESSAGES)
    .where("whatsappMessageId", "==", whatsappMessageId)
    .limit(1)
    .get();

  return !snap.empty;
}

export async function saveMessage({ leadId, phone, role, text, whatsappMessageId = null }) {
  const db = getDb();
  const timestamp = nowIso();
  const message = {
    leadId,
    phone,
    role,
    text,
    whatsappMessageId,
    timestamp
  };
  const leadPatch = {
    messageCount: FieldValue.increment(1),
    lastMessageAt: timestamp,
    updatedAt: timestamp
  };

  if (role === "user") {
    leadPatch.lastInboundAt = timestamp;
  }

  await db.collection(MESSAGES).add(message);
  await db.collection(LEADS).doc(leadId).set(leadPatch, { merge: true });
  invalidateLeadListCache();

  return message;
}

export async function getRecentMessages(leadId, limit = 5) {
  const db = getDb();
  const messageLimit = Math.min(Math.max(Number(limit) || 5, 1), 50);

  try {
    const snap = await db
      .collection(MESSAGES)
      .where("leadId", "==", leadId)
      .orderBy("timestamp", "desc")
      .limit(messageLimit)
      .get();

    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .reverse();
  } catch (error) {
    console.error("recent_messages_fast_query_failed", {
      leadId,
      error: error.message
    });
  }

  const snap = await db
    .collection(MESSAGES)
    .where("leadId", "==", leadId)
    .get();

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, messageLimit)
    .reverse();
}

export async function updateLeadFromAi(leadId, aiResult, _existingLead = null) {
  const db = getDb();
  const fields = aiResult.fields || {};
  const patch = {
    temperature: normalizeTemperature(aiResult.temperature),
    leadSummary: aiResult.summary || null,
    requirement: fields.requirement || null,
    name: fields.name || null,
    city: fields.city || null,
    budget: fields.budget || null,
    urgency: fields.urgency || null,
    updatedAt: nowIso()
  };

  Object.keys(patch).forEach((key) => patch[key] === null && delete patch[key]);

  if (aiResult.handoff_required) {
    patch.status = "contacted";
  }

  // Ownership is round-robin and sticky. The AI never reassigns a lead — it only
  // updates temperature for reporting. The owner stays whoever got it at creation.
  await db.collection(LEADS).doc(leadId).set(patch, { merge: true });
  invalidateLeadListCache();
}

const LEAD_LIST_CACHE_TTL_MS = 20 * 1000;
let leadListCache = null;
let leadListCacheAt = 0;

export function invalidateLeadListCache() {
  leadListCache = null;
  leadListCacheAt = 0;
}

async function getAllLeadsCached(queryLimit) {
  const now = Date.now();
  if (leadListCache && leadListCache.length >= Math.min(queryLimit, leadListCache.queryLimit || 0) && now - leadListCacheAt < LEAD_LIST_CACHE_TTL_MS) {
    return leadListCache;
  }

  const db = getDb();
  const snap = await db.collection(LEADS).orderBy("lastMessageAt", "desc").limit(queryLimit).get();
  const leads = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  leads.queryLimit = queryLimit;
  leadListCache = leads;
  leadListCacheAt = now;
  return leads;
}

export async function listLeads({ temperature, temperatures, assignedTo, status, limit = 50, fields = "" }) {
  const requestedLimit = Math.max(1, Number(limit) || 50);
  const queryLimit = Math.min(Math.max(requestedLimit, 500), 5000);
  let leads = await getAllLeadsCached(queryLimit);

  if (temperature) leads = leads.filter((lead) => lead.temperature === temperature);
  if (!temperature && Array.isArray(temperatures) && temperatures.length) {
    leads = leads.filter((lead) => temperatures.includes(lead.temperature || "cold"));
  }
  if (assignedTo) {
    leads = leads.filter((lead) => normalizeAssigneeValue(lead.assignedTo) === normalizeAssigneeValue(assignedTo));
  }
  if (status) leads = leads.filter((lead) => lead.status === status);

  const sliced = leads.slice(0, requestedLimit);
  return fields === "list" ? sliced.map(toListLead) : sliced;
}

function toListLead(lead) {
  return {
    id: lead.id,
    phone: lead.phone || "",
    name: lead.name || null,
    city: lead.city || null,
    requirement: lead.requirement || null,
    leadSummary: typeof lead.leadSummary === "string" ? lead.leadSummary.slice(0, 160) : null,
    temperature: lead.temperature || "cold",
    status: lead.status || "new",
    assignedTo: lead.assignedTo || null,
    callStatus: lead.callStatus || "not_called",
    followUpAt: lead.followUpAt || null,
    followUpReason: lead.followUpReason || null,
    reminderStatus: lead.reminderStatus || "none",
    nextAction: lead.nextAction || null,
    salesNote: lead.salesNote || null,
    budget: lead.budget || null,
    urgency: lead.urgency || null,
    leadScore: Number(lead.leadScore) || 0,
    lostReason: lead.lostReason || null,
    optedOut: lead.optedOut === true,
    messageCount: Number(lead.messageCount) || 0,
    createdAt: lead.createdAt || null,
    updatedAt: lead.updatedAt || null,
    lastMessageAt: lead.lastMessageAt || null
  };
}

export async function getLeadDetail(leadId, messageLimit = 20) {
  const db = getDb();
  const leadSnap = await db.collection(LEADS).doc(leadId).get();
  if (!leadSnap.exists) return null;

  let messages = [];
  try {
    messages = await getRecentMessages(leadId, messageLimit);
  } catch (error) {
    console.error("lead_messages_load_failed", {
      leadId,
      error: error.message
    });
  }
  return { id: leadSnap.id, ...leadSnap.data(), messages };
}

export async function updateLead(leadId, patch) {
  const db = getDb();
  const update = { ...patch };

  // Temperature no longer changes ownership. Only an explicit assignedTo (admin
  // reassign) moves a lead.
  if (["converted", "lost"].includes(update.status)) {
    update.sequenceStatus = "stopped";
    update.sequenceStopReason = `lead_${update.status}`;
    update.nextSequenceAt = null;
  }

  await db.collection(LEADS).doc(leadId).set({ ...update, updatedAt: nowIso() }, { merge: true });
  invalidateLeadListCache();
}

export async function startLeadSequence(leadId, patch) {
  const db = getDb();
  await db.collection(LEADS).doc(leadId).set(
    {
      sequenceStatus: "active",
      sequenceStepIndex: 0,
      lastSequenceSentAt: null,
      ...patch,
      updatedAt: nowIso()
    },
    { merge: true }
  );
}

export async function advanceLeadSequence(leadId, patch) {
  const db = getDb();
  await db.collection(LEADS).doc(leadId).set(
    {
      ...patch,
      updatedAt: nowIso()
    },
    { merge: true }
  );
}

export async function listActiveSequenceLeads(limit = 100) {
  const db = getDb();
  const snap = await db
    .collection(LEADS)
    .where("sequenceStatus", "==", "active")
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 250))
    .get();

  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// One-time (admin) equal reshuffle of every lead across the current sales team.
// Open/active leads first so nobody's live pipeline is lopsided.
export async function redistributeLeadsEqually() {
  const db = getDb();
  const team = salesTeam();
  const snap = await db.collection(LEADS).orderBy("lastMessageAt", "desc").limit(5000).get();
  const leads = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const openLeads = leads.filter((lead) => !["converted", "lost"].includes(lead.status || ""));
  const closedLeads = leads.filter((lead) => ["converted", "lost"].includes(lead.status || ""));
  const ordered = [...openLeads, ...closedLeads];

  const counts = {};
  team.forEach((member) => (counts[member] = 0));
  let batch = db.batch();
  let ops = 0;
  let updated = 0;

  for (let i = 0; i < ordered.length; i++) {
    const assignee = team[i % team.length];
    batch.set(db.collection(LEADS).doc(ordered[i].id), { assignedTo: assignee, updatedAt: nowIso() }, { merge: true });
    counts[assignee]++;
    updated++;
    ops++;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();

  // Reset rotation so the next new lead continues the balance.
  await db.collection(SETTINGS).doc(ASSIGNMENT_DOC).set({ counter: updated, updatedAt: nowIso() }, { merge: true });
  invalidateLeadListCache();

  return { updated, counts, team };
}

// Per-salesperson efficiency snapshot for the admin.
export async function getTeamStats() {
  const team = salesTeam();
  const leads = await listLeads({ limit: 5000 });
  const stats = {};

  for (const member of team) {
    stats[member] = {
      total: 0, new: 0, contacted: 0, follow_up: 0, quotation_sent: 0,
      converted: 0, lost: 0, hot: 0, warm: 0, cold: 0, openLeads: 0, avgScore: 0
    };
  }

  const scoreSum = {};
  team.forEach((member) => (scoreSum[member] = 0));

  for (const lead of leads) {
    const owner = normalizeAssigneeValue(lead.assignedTo);
    if (!stats[owner]) continue;

    const s = stats[owner];
    const status = lead.status || "new";
    const temp = lead.temperature || "cold";

    s.total++;
    if (Object.hasOwn(s, status)) s[status]++;
    if (Object.hasOwn(s, temp)) s[temp]++;
    if (!["converted", "lost"].includes(status)) s.openLeads++;
    scoreSum[owner] += Number(lead.leadScore) || 0;
  }

  for (const member of team) {
    const s = stats[member];
    const decided = s.converted + s.lost;
    s.conversionRate = decided > 0 ? Math.round((s.converted / decided) * 100) : 0;
    s.avgScore = s.total > 0 ? Math.round(scoreSum[member] / s.total) : 0;
  }

  return { team, stats };
}

export async function listSalesUsers() {
  const db = getDb();
  const snap = await db.collection(SALES_USERS).where("active", "==", true).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function normalizeTemperature(value) {
  if (["hot", "warm", "cold"].includes(value)) return value;
  return "cold";
}

function normalizeAssigneeValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pinky") return "ankit";
  return normalized;
}
