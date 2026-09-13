import { getDb } from "../firebase.js";

const COLLECTION = "marketingCampaigns";

function positiveLimit(value) {
  const limit = Number(value) || 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function publicCampaign(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    templateName: String(data.templateName || ""),
    languageCode: String(data.languageCode || "en"),
    targets: Array.isArray(data.targets) ? data.targets : [],
    target: String(data.target || ""),
    requested: Number(data.requested) || 0,
    sent: Number(data.sent) || 0,
    failed: Number(data.failed) || 0,
    replies: Number(data.replies) || 0,
    status: String(data.status || "completed"),
    startedAt: data.startedAt || "",
    completedAt: data.completedAt || "",
    createdBy: String(data.createdBy || "admin"),
    failureSummary: Array.isArray(data.failureSummary)
      ? data.failureSummary.slice(0, 10)
      : [],
  };
}

export async function createMarketingCampaign(input = {}) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc();
  const startedAt = new Date().toISOString();
  const campaign = {
    templateName: String(input.templateName || ""),
    languageCode: String(input.languageCode || "en"),
    targets: Array.isArray(input.targets) ? input.targets : [],
    target: String(input.target || ""),
    requested: Number(input.requested) || 0,
    sent: 0,
    failed: 0,
    replies: 0,
    status: "sending",
    startedAt,
    completedAt: "",
    updatedAt: startedAt,
    createdBy: String(input.createdBy || "admin"),
    failureSummary: [],
  };
  await ref.set(campaign);
  return { id: ref.id, ...campaign };
}

export async function completeMarketingCampaign(campaignId, result = {}) {
  if (!campaignId) return;
  const sent = Number(result.sent) || 0;
  const failed = Number(result.failed) || 0;
  const completedAt = new Date().toISOString();
  await getDb()
    .collection(COLLECTION)
    .doc(campaignId)
    .set(
      {
        requested: Number(result.requested) || sent + failed,
        sent,
        failed,
        status: failed ? (sent ? "partial" : "failed") : "completed",
        completedAt,
        updatedAt: completedAt,
        failureSummary: Array.isArray(result.failures)
          ? result.failures.slice(0, 10).map((item) => ({
              phone: String(item.phone || ""),
              error: String(item.error || "").slice(0, 240),
            }))
          : [],
      },
      { merge: true },
    );
}

export async function failMarketingCampaign(campaignId, error) {
  if (!campaignId) return;
  const completedAt = new Date().toISOString();
  await getDb()
    .collection(COLLECTION)
    .doc(campaignId)
    .set(
      {
        status: "failed",
        completedAt,
        updatedAt: completedAt,
        failureSummary: [
          { phone: "", error: String(error?.message || error).slice(0, 240) },
        ],
      },
      { merge: true },
    );
}

export async function listMarketingCampaigns(value) {
  const snapshot = await getDb()
    .collection(COLLECTION)
    .orderBy("startedAt", "desc")
    .limit(positiveLimit(value))
    .get();
  const campaigns = snapshot.docs.map(publicCampaign);
  const summary = campaigns.reduce(
    (totals, campaign) => {
      totals.campaigns += 1;
      totals.sent += campaign.sent;
      totals.failed += campaign.failed;
      totals.replies += campaign.replies;
      return totals;
    },
    { campaigns: 0, sent: 0, failed: 0, replies: 0, responseRate: 0 },
  );
  summary.responseRate = summary.sent
    ? Number(((summary.replies / summary.sent) * 100).toFixed(1))
    : 0;
  return { campaigns, summary };
}
