import { createHash } from "node:crypto";
import { getDb, FieldValue } from "../firebase.js";

export const messageKey = (id) =>
  createHash("sha256").update(String(id)).digest("hex");
const rank = { accepted: 0, sent: 1, delivered: 2, read: 3 };
export function nextDeliveryStatus(current, incoming) {
  if (incoming === "failed")
    return ["delivered", "read"].includes(current) ? current : "failed";
  if (!Object.hasOwn(rank, incoming)) return current;
  if (current === "failed")
    return ["delivered", "read"].includes(incoming) ? incoming : current;
  return (rank[incoming] ?? -1) >= (rank[current] ?? -1) ? incoming : current;
}
export async function recordMessage(input) {
  const db = getDb();
  const timestamp =
    input.timestamp && Number.isFinite(Date.parse(input.timestamp))
      ? new Date(input.timestamp).toISOString()
      : new Date().toISOString();
  const ref = input.whatsappMessageId
    ? db.collection("messages").doc(messageKey(input.whatsappMessageId))
    : db.collection("messages").doc();
  const leadRef = db.collection("leads").doc(input.leadId);
  const statusRef = input.whatsappMessageId
    ? db.collection("messageStatuses").doc(messageKey(input.whatsappMessageId))
    : null;
  return db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) return { id: ref.id, ...old.data(), duplicate: true };
    const leadSnap = await tx.get(leadRef);
    const receipt = statusRef ? await tx.get(statusRef) : null;
    const lead = leadSnap.data() || {};
    const reactionRef =
      input.type === "reaction" && input.reaction?.message_id
        ? db.collection("messages").doc(messageKey(input.reaction.message_id))
        : null;
    const reactionTarget = reactionRef ? await tx.get(reactionRef) : null;
    const message = {
      leadId: input.leadId,
      phone: input.phone,
      role: input.role,
      text: String(input.text || ""),
      type: input.type || "text",
      media: input.media || null,
      context: input.context || null,
      location: input.location || null,
      contacts: input.contacts || null,
      reaction: input.reaction || null,
      order: input.order || null,
      product: input.product || null,
      template: input.template || null,
      statusTimes: {
        ...(input.role === "user"
          ? { received: timestamp }
          : { accepted: timestamp }),
        ...(receipt?.data()?.statusTimes || {}),
      },
      whatsappMessageId: input.whatsappMessageId || null,
      clientMessageId: input.clientMessageId || null,
      timestamp,
      status:
        input.role === "user"
          ? "received"
          : receipt?.data()?.status || input.status || "unknown",
      error: receipt?.data()?.error || null,
    };
    const patch = {
      messageCount: FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    };
    if (
      input.type !== "reaction" &&
      (!lead.lastMessageAt || timestamp >= lead.lastMessageAt)
    ) {
      Object.assign(patch, {
        lastMessageAt: timestamp,
        lastMessageText: message.text.slice(0, 300),
        lastMessageType: message.type,
        lastMessageRole: message.role,
        lastMessageStatus: message.status,
        lastMessageId: ref.id,
      });
    }
    if (message.role === "user" && input.type !== "reaction") {
      patch.inboundCount = FieldValue.increment(1);
      if (!lead.lastInboundAt || timestamp >= lead.lastInboundAt)
        patch.lastInboundAt = timestamp;
      const marketingSentAt =
        lead.lastMarketingSentAt ||
        (/marketing/i.test(String(lead.lastBroadcastTemplate || ""))
          ? lead.lastBroadcastAt
          : "");
      const marketingSentTime = Date.parse(marketingSentAt);
      const previouslyAwaiting =
        lead.marketingAwaitingReply === true ||
        (Number.isFinite(marketingSentTime) &&
          (!Number.isFinite(Date.parse(lead.lastInboundAt)) ||
            Date.parse(lead.lastInboundAt) <= marketingSentTime));
      if (previouslyAwaiting && timestamp >= marketingSentAt) {
        patch.marketingAwaitingReply = false;
        patch.marketingReplyPending = true;
        patch.lastMarketingReplyAt = timestamp;
        patch.lastMarketingReplyText = message.text.slice(0, 300);
      }
    }
    if (message.role === "sales" && lead.marketingReplyPending === true) {
      patch.marketingReplyPending = false;
      patch.lastMarketingFollowUpAt = timestamp;
    }
    tx.set(ref, message);
    if (
      reactionTarget?.exists &&
      reactionTarget.data().leadId === input.leadId
    ) {
      const sender = input.role === "user" ? "customer" : "business";
      const previous = reactionTarget.data().reactions?.[sender];
      if (!previous?.timestamp || timestamp >= previous.timestamp)
        tx.set(
          reactionRef,
          {
            reactions: {
              [sender]: { emoji: input.reaction.emoji || "", timestamp },
            },
          },
          { merge: true },
        );
    }
    tx.set(leadRef, patch, { merge: true });
    return { id: ref.id, ...message, duplicate: false };
  });
}
export async function recordStatus(status) {
  if (
    !status?.id ||
    !["sent", "delivered", "read", "failed"].includes(status.status)
  )
    return;
  const db = getDb();
  // Keep early receipts so a webhook racing the send response is not lost.
  const statusRef = db.collection("messageStatuses").doc(messageKey(status.id));
  const ref = db.collection("messages").doc(messageKey(status.id));
  await db.runTransaction(async (tx) => {
    const [receipt, message] = await Promise.all([
      tx.get(statusRef),
      tx.get(ref),
    ]);
    const data = message.data();
    const leadRef = data ? db.collection("leads").doc(data.leadId) : null;
    const lead = leadRef ? await tx.get(leadRef) : null;
    const next = nextDeliveryStatus(
      data?.status || receipt.data()?.status || "accepted",
      status.status,
    );
    const eventTime = Number(status.timestamp),
      eventDate =
        Number.isFinite(eventTime) && eventTime > 0 && eventTime < 8640000000000
          ? new Date(eventTime * 1000).toISOString()
          : new Date().toISOString();
    const times = {
      ...(receipt.data()?.statusTimes || {}),
      ...(data?.statusTimes || {}),
    };
    if (!times[status.status] || eventDate < times[status.status])
      times[status.status] = eventDate;
    const error =
      next === "failed"
        ? String(
            status.errors?.[0]?.message ||
              status.errors?.[0]?.title ||
              "WhatsApp could not deliver this message",
          ).slice(0, 500)
        : null;
    tx.set(
      statusRef,
      {
        status: next,
        error,
        statusTimes: times,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    if (data) {
      tx.set(ref, { status: next, error, statusTimes: times }, { merge: true });
      if (lead?.data()?.lastMessageId === ref.id)
        tx.set(leadRef, { lastMessageStatus: next }, { merge: true });
    }
  });
}
export async function getMessage(id) {
  const snap = await getDb().collection("messages").doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
export async function listChatMessages(
  leadId,
  before = "",
  requestedLimit = 40,
) {
  const db = getDb();
  const limit = Math.min(
    Math.max(Math.floor(Number(requestedLimit) || 40), 1),
    100,
  );
  let query = db
    .collection("messages")
    .where("leadId", "==", leadId)
    .orderBy("timestamp", "desc");
  if (before) {
    const cursor = await db.collection("messages").doc(before).get();
    if (!cursor.exists || cursor.data().leadId !== leadId)
      throw Object.assign(new Error("Invalid message cursor"), { status: 400 });
    query = query.startAfter(cursor);
  }
  const snap = await query.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  return {
    messages: docs.map((doc) => ({ id: doc.id, ...doc.data() })).reverse(),
    nextCursor: snap.docs.length > limit ? docs.at(-1).id : null,
  };
}
export function inboxReadState(data, role, viewer = role) {
  const raw = data.inboundCount;
  const tracked =
    raw !== undefined &&
    raw !== null &&
    Number.isSafeInteger(Number(raw)) &&
    Number(raw) >= 0;
  const inbound = tracked ? Number(raw) : 0;
  const stored =
    Number(
      data.readInboundCounts?.[viewer] ?? data.readInboundCounts?.[role],
    ) || 0;
  const read = Math.min(inbound, Math.max(0, Math.floor(stored)));
  const unread = inbound - read;
  const manual = data.manualUnread?.[viewer] === true;
  return {
    manualUnread: manual,
    unreadCount: Math.max(manual ? 1 : 0, unread),
    readTrackingAvailable: tracked,
    readMessageCount: tracked ? read : null,
    unreadMessageCount: tracked ? unread : null,
  };
}
export function marketingReplyTracked(data = {}) {
  const sentAt = Date.parse(
    data.lastMarketingSentAt || data.lastBroadcastAt || "",
  );
  const replyAt = Date.parse(
    data.lastMarketingReplyAt || data.lastInboundAt || "",
  );
  const knownMarketingSend =
    Boolean(data.lastMarketingSentAt) ||
    /marketing/i.test(String(data.lastBroadcastTemplate || ""));
  return (
    knownMarketingSend &&
    Number.isFinite(sentAt) &&
    Number.isFinite(replyAt) &&
    replyAt > sentAt
  );
}
export function marketingReplyPending(data = {}) {
  if (data.marketingReplyPending === true) return true;
  if (data.marketingReplyPending === false) return false;
  if (!marketingReplyTracked(data)) return false;
  const inboundAt = Date.parse(
    data.lastMarketingReplyAt || data.lastInboundAt || "",
  );
  const humanAt = Date.parse(data.lastHumanTouchAt || "");
  return !Number.isFinite(humanAt) || humanAt < inboundAt;
}
function inboxChat(doc, role, viewer) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    assignedTo: data.assignedTo === "pinky" ? "ankit" : data.assignedTo,
    marketingReplyTracked: marketingReplyTracked(data),
    marketingReplyPending: marketingReplyPending(data),
    view: data.chatViews?.[viewer] || {},
    ...inboxReadState(data, role, viewer),
  };
}
export async function listInbox(role, cursor = "", viewer = role) {
  const db = getDb();
  const syncAt = new Date().toISOString();
  let query = db.collection("leads");
  const owners = role === "ankit" ? ["ankit", "pinky"] : [role];
  if (role !== "admin") query = query.where("assignedTo", "in", owners);
  query = query.orderBy("lastMessageAt", "desc");
  if (cursor) {
    const snap = await db.collection("leads").doc(cursor).get();
    if (
      !snap.exists ||
      (role !== "admin" && !owners.includes(snap.data().assignedTo))
    )
      throw Object.assign(new Error("Invalid chat cursor"), { status: 400 });
    query = query.startAfter(snap);
  }
  const snap = await query.limit(101).get();
  const docs = snap.docs.slice(0, 100);
  return {
    chats: docs.map((doc) => inboxChat(doc, role, viewer)),
    nextCursor: snap.docs.length > 100 ? docs.at(-1).id : null,
    syncAt,
  };
}
export async function listInboxChanges(role, since, viewer = role) {
  const parsed = Date.parse(String(since || ""));
  if (!Number.isFinite(parsed))
    throw Object.assign(new Error("A valid inbox sync time is required"), {
      status: 400,
    });
  const db = getDb();
  const syncAt = new Date().toISOString();
  let query = db.collection("leads");
  const owners = role === "ankit" ? ["ankit", "pinky"] : [role];
  if (role !== "admin") query = query.where("assignedTo", "in", owners);
  const snap = await query
    .where("lastMessageAt", ">", new Date(parsed).toISOString())
    .where("lastMessageAt", "<=", syncAt)
    .orderBy("lastMessageAt", "desc")
    .limit(501)
    .get();
  const resetRequired = snap.docs.length > 500;
  return {
    chats: resetRequired
      ? []
      : snap.docs.map((doc) => inboxChat(doc, role, viewer)),
    syncAt,
    resetRequired,
  };
}
export async function markChatRead(
  leadId,
  viewer,
  visibleCount,
  role = viewer,
) {
  const db = getDb(),
    ref = db.collection("leads").doc(leadId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      data = snap.data() || {};
    const inbound = Math.max(0, Math.floor(Number(data.inboundCount) || 0));
    const count = Math.min(
      inbound,
      Math.max(
        Number(
          data.readInboundCounts?.[viewer] ?? data.readInboundCounts?.[role],
        ) || 0,
        Math.max(0, Math.floor(Number(visibleCount) || 0)),
      ),
    );
    tx.set(
      ref,
      {
        readInboundCounts: { [viewer]: count },
        manualUnread: { [viewer]: false },
      },
      { merge: true },
    );
  });
}
export async function claimOutbound(leadId, key, fingerprint) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key || ""))
    throw Object.assign(new Error("A valid client message ID is required"), {
      status: 400,
    });
  const db = getDb(),
    ref = db.collection("outboundRequests").doc(messageKey(leadId + ":" + key));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      if (data.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Message ID was already used for different content"),
          { status: 409 },
        );
      if (data.state === "sent") return { ref, existing: data.message };
      throw Object.assign(
        new Error(
          "This send was already attempted. Refresh the conversation before sending again.",
        ),
        { status: 409 },
      );
    }
    tx.set(ref, {
      leadId,
      fingerprint,
      state: "pending",
      createdAt: new Date().toISOString(),
    });
    return { ref, existing: null };
  });
}
