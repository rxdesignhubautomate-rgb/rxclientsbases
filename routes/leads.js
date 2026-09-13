import express from "express";
import { config } from "../config.js";
import {
  getLeadDetail,
  getTeamStats,
  listLeads,
  listSalesUsers,
  redistributeLeadsEqually,
  saveMessage,
  updateLead
} from "../services/leadStore.js";
import {
  getSequenceVideoSettings,
  saveVisualAidSequenceCaptions,
  saveVisualAidSequenceVideo
} from "../services/sequenceVideoStore.js";
import { sendWhatsAppTemplate, sendWhatsAppText, uploadWhatsAppMedia } from "../services/whatsapp.js";

export const leadsRouter = express.Router();

const LEAD_STATUSES = ["new", "contacted", "follow_up", "quotation_sent", "converted", "lost"];
const LEAD_TEMPERATURES = ["hot", "warm", "cold"];
const CALL_STATUSES = ["not_called", "called", "no_answer", "callback", "interested", "not_interested", "converted"];
const REMINDER_STATUSES = ["none", "scheduled", "due", "snoozed", "done"];
const BROADCAST_TARGETS = ["all", "hot", "warm", "cold", "new", "follow_up", "quote_sent", "interested"];

leadsRouter.get("/", async (req, res, next) => {
  try {
    const assigneeScope = deviceAssigneeScope(req);

    const leads = await listLeads({
      temperature: req.query.temperature,
      assignedTo: assigneeScope || req.query.assignedTo,
      status: req.query.status,
      limit: req.query.limit || 50,
      fields: String(req.query.fields || "")
    });
    res.json({ leads });
  } catch (error) {
    next(error);
  }
});

leadsRouter.get("/meta/options", (_req, res) => {
  res.json({
    statuses: LEAD_STATUSES,
    temperatures: LEAD_TEMPERATURES,
    callStatuses: CALL_STATUSES,
    reminderStatuses: REMINDER_STATUSES,
    salesTeam: config.salesTeam
  });
});

leadsRouter.get("/team/stats", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device) && deviceAssigneeScope(req)) {
      return res.status(403).json({ error: "Admin only" });
    }
    const data = await getTeamStats();
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/team/redistribute", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device) && deviceAssigneeScope(req)) {
      return res.status(403).json({ error: "Admin only" });
    }
    const result = await redistributeLeadsEqually();
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

leadsRouter.get("/sales-users", async (_req, res, next) => {
  try {
    const salesUsers = await listSalesUsers();
    res.json({ salesUsers });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/broadcast/preview", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for broadcast" });
    }

    const target = normalizeBroadcastTarget(req.body.target);
    const limit = normalizeBroadcastLimit(req.body.limit);
    const candidates = await getBroadcastCandidates(target, limit);

    res.json({
      ok: true,
      target,
      count: candidates.length,
      sample: candidates.slice(0, 5).map((lead) => ({
        id: lead.id,
        phone: lead.phone,
        name: lead.name || "",
        status: lead.status || "new",
        temperature: lead.temperature || "cold",
        callStatus: lead.callStatus || "not_called"
      }))
    });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/broadcast/summary", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for broadcast summary" });
    }

    const all = await getBroadcastCandidates("all", 5000);
    const hot = await getBroadcastCandidates("hot", 5000);
    const warm = await getBroadcastCandidates("warm", 5000);
    const cold = await getBroadcastCandidates("cold", 5000);

    res.json({
      ok: true,
      templateName: "visual_aid_marketing",
      counts: {
        all: all.length,
        hot: hot.length,
        warm: warm.length,
        cold: cold.length
      }
    });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/broadcast/upload-video", express.raw({ type: ["video/mp4", "application/octet-stream"], limit: "16mb" }), async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for media upload" });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "Video file is required" });
    }

    const media = await uploadWhatsAppMedia(req.body, {
      mimeType: req.headers["content-type"] || "video/mp4",
      filename: "visual-aid-marketing.mp4"
    });

    res.json({
      ok: true,
      id: media.id
    });
  } catch (error) {
    next(error);
  }
});

leadsRouter.get("/sequence/videos", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for sequence videos" });
    }

    const settings = await getSequenceVideoSettings();
    res.json({ ok: true, ...settings });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/sequence/videos/upload/:slot", express.raw({ type: ["video/mp4", "image/jpeg", "image/png", "application/octet-stream"], limit: "16mb" }), async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for sequence video upload" });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "Video file is required" });
    }

    const slot = Number(req.params.slot);
    if (![1, 2, 3, 4].includes(slot)) {
      return res.status(400).json({ error: "Valid video slot 1-4 is required" });
    }

    const mimeType = String(req.headers["content-type"] || (slot === 4 ? "image/jpeg" : "video/mp4"));
    const filename = slot === 4
      ? `visual-aid-sequence-${slot}.${mimeType.includes("png") ? "png" : "jpg"}`
      : `visual-aid-sequence-${slot}.mp4`;
    const media = await uploadWhatsAppMedia(req.body, {
      mimeType,
      filename
    });

    let settings = {};
    let saveWarning = "";
    try {
      settings = await saveVisualAidSequenceVideo(slot, media.id);
    } catch (saveError) {
      saveWarning = `Media uploaded to Meta but could not be saved in Firestore: ${saveError.message}`;
      console.error("sequence_media_save_failed", {
        slot,
        mediaId: media.id,
        error: saveError.message
      });
    }

    res.json({
      ok: true,
      slot,
      id: media.id,
      saveWarning,
      ...settings
    });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/sequence/videos/captions", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for sequence captions" });
    }

    const settings = await saveVisualAidSequenceCaptions(req.body || {});
    res.json({ ok: true, ...settings });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/broadcast/send", async (req, res, next) => {
  try {
    if (!isAdminDevice(req.device)) {
      return res.status(403).json({ error: "Admin device required for broadcast" });
    }

    const mode = normalizeBroadcastMode(req.body.mode);
    const message = String(req.body.message || "").trim();
    const templateOptions = normalizeTemplateOptions(req.body);
    if (mode === "text" && !message) {
      return res.status(400).json({ error: "Broadcast message is required" });
    }
    if (mode === "template" && !templateOptions.name) {
      return res.status(400).json({ error: "Template name is required" });
    }

    const target = normalizeBroadcastTarget(req.body.target);
    const limit = normalizeBroadcastLimit(req.body.limit);
    const rawTestPhone = String(req.body.testPhone || "").trim();
    const testPhone = normalizeTestPhone(rawTestPhone);
    const rawBulkPhones = String(req.body.bulkPhones || "").trim();
    const bulkResult = normalizeBulkPhones(rawBulkPhones, limit);
    if (rawTestPhone && !testPhone) {
      return res.status(400).json({ error: "Valid custom test number is required" });
    }
    if (!testPhone && rawBulkPhones && !bulkResult.phones.length) {
      return res.status(400).json({ error: "No valid bulk numbers found" });
    }

    const isDirectNumberSend = Boolean(testPhone || bulkResult.phones.length);
    const candidates = testPhone
      ? [{ id: "test", phone: testPhone }]
      : bulkResult.phones.length
        ? bulkResult.phones.map((phone, index) => ({ id: `bulk_${index + 1}`, phone }))
        : await getBroadcastCandidates(target, limit);
    const text = mode === "template"
      ? `Template: ${templateOptions.name}`
      : withStopFooter(message);
    const failures = [];
    let sent = 0;

    for (const lead of candidates) {
      try {
        if (mode === "template") {
          await sendWhatsAppTemplate(lead.phone, templateOptions);
        } else {
          await sendWhatsAppText(lead.phone, text);
        }
        if (!isDirectNumberSend) {
          await saveMessage({
            leadId: lead.id,
            phone: lead.phone,
            role: "broadcast",
            text
          });
          await updateLead(lead.id, {
            lastBroadcastAt: new Date().toISOString(),
            lastBroadcastTarget: target,
            lastBroadcastTemplate: mode === "template" ? templateOptions.name : ""
          });
        }
        sent++;
      } catch (error) {
        failures.push({
          id: lead.id,
          phone: lead.phone,
          error: error.message
        });
      }
    }

    res.json({
      ok: true,
      mode,
      target: testPhone ? "test_number" : bulkResult.phones.length ? "bulk_numbers" : target,
      templateName: mode === "template" ? templateOptions.name : "",
      requested: candidates.length,
      sent,
      failed: failures.length,
      totalSubmitted: bulkResult.totalSubmitted,
      invalidNumbers: bulkResult.invalidCount,
      duplicatesRemoved: bulkResult.duplicatesRemoved,
      failures: failures.slice(0, 10)
    });
  } catch (error) {
    next(error);
  }
});

leadsRouter.get("/:leadId", async (req, res, _next) => {
  try {
    const lead = await getLeadDetail(req.params.leadId, normalizeMessageLimit(req.query.messages));
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!canDeviceAccessLead(req, lead)) {
      return res.status(403).json({ error: "Lead not allowed for this device" });
    }
    res.json({ lead });
  } catch (error) {
    console.error("lead_detail_open_failed", {
      leadId: req.params.leadId,
      error: error.message
    });
    res.json({
      lead: {
        id: req.params.leadId,
        phone: req.params.leadId,
        name: "Lead",
        temperature: fallbackTemperature(req.device),
        status: "new",
        assignedTo: fallbackAssignee(req.device),
        leadSummary: "Lead opened in safe mode because backend detail loading failed.",
        messages: []
      }
    });
  }
});

leadsRouter.patch("/:leadId", async (req, res, next) => {
  try {
    const lead = await getLeadDetail(req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!canDeviceAccessLead(req, lead)) {
      return res.status(403).json({ error: "Lead not allowed for this device" });
    }

    const patch = pickLeadPatch(req.body);
    if (isEngagementPatch(patch)) {
      patch.lastHumanTouchAt = new Date().toISOString();
    }
    await updateLead(req.params.leadId, patch);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/:leadId/update", async (req, res, next) => {
  try {
    const lead = await getLeadDetail(req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!canDeviceAccessLead(req, lead)) {
      return res.status(403).json({ error: "Lead not allowed for this device" });
    }

    const patch = pickLeadPatch(req.body);
    if (isEngagementPatch(patch)) {
      patch.lastHumanTouchAt = new Date().toISOString();
    }
    await updateLead(req.params.leadId, patch);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

leadsRouter.post("/:leadId/send", async (req, res, next) => {
  try {
    const lead = await getLeadDetail(req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!canDeviceAccessLead(req, lead)) {
      return res.status(403).json({ error: "Lead not allowed for this device" });
    }

    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });

    await sendWhatsAppText(lead.phone, text);
    await saveMessage({
      leadId: lead.id,
      phone: lead.phone,
      role: "sales",
      text
    });
    await updateLead(lead.id, {
      aiEnabled: false,
      status: "contacted",
      lastHumanTouchAt: new Date().toISOString()
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function isEngagementPatch(patch) {
  if (Object.hasOwn(patch, "salesNote") && String(patch.salesNote || "").trim()) return true;
  if (Object.hasOwn(patch, "callStatus") && patch.callStatus && patch.callStatus !== "not_called") return true;
  if (Object.hasOwn(patch, "followUpAt") && patch.followUpAt) return true;
  return false;
}

function pickLeadPatch(body) {
  const allowed = [
    "assignedTo",
    "status",
    "temperature",
    "aiEnabled",
    "name",
    "city",
    "budget",
    "urgency",
    "requirement",
    "callStatus",
    "followUpAt",
    "followUpReason",
    "reminderStatus",
    "nextAction",
    "salesNote",
    "lostReason",
    "leadScore",
    "lastHotAlertAt",
    "optedOut",
    "broadcastOptOutAt",
    "broadcastOptInAt",
    "lastBroadcastAt",
    "lastBroadcastTarget",
    "lastBroadcastTemplate"
  ];
  const patch = {};

  for (const key of allowed) {
    if (Object.hasOwn(body, key)) patch[key] = body[key];
  }

  return patch;
}

function deviceAssigneeScope(requestOrDevice = {}) {
  const device = requestOrDevice.device || requestOrDevice;

  const headerRole = normalizeAssigneeValue(requestOrDevice.headers?.["x-device-role"]);
  const headerUser = normalizeAssigneeValue(requestOrDevice.headers?.["x-device-user"]);
  if (headerRole === "admin" || headerUser === "admin") return "";

  const team = config.salesTeam;
  if (team.includes(headerRole)) return headerRole;
  if (team.includes(headerUser)) return headerUser;

  if (device && (device.role === "admin" || device.bootstrap)) return "";

  const deviceRole = normalizeAssigneeValue(device?.role);
  if (team.includes(deviceRole)) return deviceRole;

  // Unknown sales device: scope to a non-existent owner so it sees nothing
  // rather than leaking the whole pipeline.
  return "__none__";
}

function fallbackTemperature() {
  return "cold";
}

function fallbackAssignee(device = {}) {
  const role = normalizeAssigneeValue(device?.role);
  return config.salesTeam.includes(role) ? role : "";
}

function canDeviceAccessLead(requestOrDevice, lead) {
  const assigneeScope = deviceAssigneeScope(requestOrDevice);
  return !assigneeScope || normalizeAssigneeValue(lead.assignedTo) === assigneeScope;
}

function normalizeAssigneeValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pinky") return "ankit";
  return normalized;
}

function isAdminDevice(device = {}) {
  return Boolean(device?.bootstrap || device?.role === "admin");
}

function normalizeBroadcastTarget(value) {
  const target = String(value || "all").trim().toLowerCase();
  return BROADCAST_TARGETS.includes(target) ? target : "all";
}

function normalizeBroadcastMode(value) {
  const mode = String(value || "text").trim().toLowerCase();
  return mode === "template" ? "template" : "text";
}

function normalizeTemplateOptions(body = {}) {
  return {
    name: String(body.templateName || "visual_aid_marketing").trim(),
    languageCode: String(body.languageCode || "en").trim() || "en",
    headerType: String(body.headerType || "video").trim().toLowerCase(),
    headerMedia: String(body.headerMedia || "").trim(),
    bodyParameters: normalizeTemplateParameters(body.bodyParameters)
  };
}

function normalizeTemplateParameters(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTestPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;

  return "";
}

function normalizeBulkPhones(value, limit) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { phones: [], invalidCount: 0, duplicatesRemoved: 0, totalSubmitted: 0 };
  }

  const parts = raw
    .split(/[\n\r,;\t]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set();
  const phones = [];
  let invalidCount = 0;
  let duplicatesRemoved = 0;

  for (const part of parts) {
    const phone = normalizeTestPhone(part);
    if (!phone) {
      invalidCount++;
      continue;
    }
    if (seen.has(phone)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(phone);
    if (phones.length < limit) phones.push(phone);
  }

  return {
    phones,
    invalidCount,
    duplicatesRemoved,
    totalSubmitted: parts.length
  };
}

function normalizeBroadcastLimit(value) {
  const limit = Number(value) || 25;
  return Math.min(Math.max(limit, 1), 5000);
}

function normalizeMessageLimit(value) {
  const limit = Number(value) || 20;
  return Math.min(Math.max(limit, 1), 50);
}

async function getBroadcastCandidates(target, limit) {
  const leads = await listLeads({ limit: 5000 });
  const seenPhones = new Set();

  return leads
    .filter((lead) => {
      const phone = String(lead.phone || "").trim();
      if (!phone || seenPhones.has(phone)) return false;
      seenPhones.add(phone);
      if (lead.optedOut === true) return false;
      if ((lead.status || "new") === "lost") return false;
      return matchesBroadcastTarget(lead, target);
    })
    .slice(0, limit);
}

function matchesBroadcastTarget(lead, target) {
  const status = lead.status || "new";
  const temperature = lead.temperature || "cold";
  const callStatus = lead.callStatus || "not_called";

  if (target === "all") return true;
  if (["hot", "warm", "cold"].includes(target)) return temperature === target;
  if (target === "new") return status === "new";
  if (target === "follow_up") return status === "follow_up" || callStatus === "callback";
  if (target === "quote_sent") return status === "quotation_sent";
  if (target === "interested") return callStatus === "interested" && status !== "quotation_sent" && status !== "converted";
  return true;
}

function withStopFooter(message) {
  if (/reply\s+stop|stop\s+to|unsubscribe/i.test(message)) {
    return message;
  }
  return `${message}\n\nReply STOP to stop these updates.`;
}
