import { getDb } from "../firebase.js";
import { config } from "../config.js";
import { getDevice } from "../services/deviceStore.js";
import { updateLead, getRecentMessages } from "../services/leadStore.js";
import {
  claimOutbound,
  getMessage,
  recordMessage,
  messageKey,
} from "../services/chatStore.js";
import {
  viewerKey,
  userRef,
  timestamp,
  bad,
  cleanPhone,
  searchHistory,
  saveChatView,
  cleanPreferences,
} from "../services/chatFeaturesStore.js";
import {
  graphApi,
  sendStructuredMessage,
  sendTypingIndicator,
} from "../services/whatsapp.js";
import {
  sequenceControl,
  defaultSequence,
  validateSequenceSteps,
} from "../services/sequenceControls.js";
import { forwardMessages } from "../services/forwardMessages.js";
import { inspectSequenceMedia } from "../services/sequenceMedia.js";

const capabilities = {
  calling: {
    status: "needs_verification",
    reason:
      "Voice calling needs an eligible business number, permissions and a calling service. Video calling requires separate verification.",
  },
  groups: {
    status: "needs_verification",
    reason:
      "Group API access and account eligibility have not been verified. Communities and Channels are separate features.",
  },
  status: {
    status: "not_integrated",
    reason:
      "Status stories, polls and events do not have a verified integration in this CRM.",
  },
  presence: {
    status: "not_integrated",
    reason:
      "Customer profile photos, About, last seen, online and incoming typing are not available from this integration.",
  },
  editing: {
    status: "not_integrated",
    reason:
      "Editing sent messages and Delete for everyone have no verified endpoint in this integration.",
  },
  historySync: {
    status: "needs_onboarding",
    reason:
      "Phone history sync and linked devices require an eligible onboarding/coexistence integration; this is not QR pairing.",
  },
};

export function installChatFeatureRoutes(
  router,
  { chatRole, leadFor, handle, assertCanSend },
) {
  const user = (req) => {
    const role = chatRole(req);
    return { role, key: viewerKey(req, role) };
  };
  const scoped = async (req) => ({ ...(await leadFor(req)), ...user(req) });
  router.get(
    "/preferences",
    handle(async (req, res) => {
      const { key, role } = user(req),
        snap = await userRef(key).get();
      res.json({
        preferences: snap.data()?.preferences || {},
        quickReplies: snap.data()?.quickReplies || [],
        role,
        team: config.salesTeam,
        capabilities,
      });
    }),
  );
  router.post(
    "/preferences",
    handle(async (req, res) => {
      const { key } = user(req),
        preferences = cleanPreferences(req.body);
      await userRef(key).set({ preferences }, { merge: true });
      res.json({
        ok: true,
        preferences: (await userRef(key).get()).data().preferences,
      });
    }),
  );
  router.post(
    "/quick-replies",
    handle(async (req, res) => {
      const { key } = user(req);
      if (!Array.isArray(req.body.replies) || req.body.replies.length > 50)
        throw bad("Use at most 50 quick replies.");
      const replies = req.body.replies
        .map((r) => ({
          title: String(r.title || "")
            .trim()
            .slice(0, 80),
          text: String(r.text || "")
            .trim()
            .slice(0, 4096),
        }))
        .filter((r) => r.title && r.text);
      await userRef(key).set({ quickReplies: replies }, { merge: true });
      res.json({ replies });
    }),
  );
  router.post(
    "/new",
    handle(async (req, res) => {
      const { role } = user(req),
        phone = cleanPhone(req.body.phone),
        ref = getDb().collection("leads").doc(phone);
      const lead = await getDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          const old = snap.data(),
            owner = old.assignedTo === "pinky" ? "ankit" : old.assignedTo;
          if (role !== "admin" && owner !== role)
            throw bad(
              "This contact belongs to another agent. Ask an admin to assign it to you.",
              403,
            );
          return { id: ref.id, ...old };
        }
        const value = {
          phone,
          name: String(req.body.name || "")
            .trim()
            .slice(0, 100),
          assignedTo: role === "admin" ? config.salesTeam[0] || "admin" : role,
          status: "new",
          temperature: "cold",
          aiEnabled: false,
          optedOut: false,
          createdAt: timestamp(),
          updatedAt: timestamp(),
          lastMessageAt: timestamp(),
          lastMessageText: "",
          messageCount: 0,
          inboundCount: 0,
          lastInboundAt: null,
          consentRecordedAt: req.body.consent === true ? timestamp() : null,
        };
        tx.set(ref, value);
        return { id: ref.id, ...value };
      });
      res.json({ lead });
    }),
  );
  router.get(
    "/templates",
    handle(async (req, res) => {
      user(req);
      if (!config.whatsappBusinessAccountId)
        return res.json({
          templates: [],
          configured: false,
          reason:
            "Set WHATSAPP_BUSINESS_ACCOUNT_ID on the backend to load approved templates.",
        });
      const data = await graphApi(
        `${config.whatsappBusinessAccountId}/message_templates`,
        {
          query: {
            status: "APPROVED",
            fields: "id,name,language,category,status,components",
            limit: 100,
            after: String(req.query.after || "").slice(0, 1000),
          },
        },
      );
      res.json({
        configured: true,
        templates: (data.data || []).filter((t) => t.status === "APPROVED"),
        nextCursor: data.paging?.next ? data.paging?.cursors?.after : null,
      });
    }),
  );
  router.get(
    "/catalogue",
    handle(async (req, res) => {
      user(req);
      if (!config.whatsappCatalogId)
        return res.json({
          configured: false,
          products: [],
          reason:
            "Connect a Meta product catalogue and set WHATSAPP_CATALOG_ID on the backend.",
        });
      const data = await graphApi(`${config.whatsappCatalogId}/products`, {
        query: {
          fields: "id,name,retailer_id,price,currency,availability",
          limit: 100,
          after: String(req.query.after || "").slice(0, 1000),
        },
      });
      res.json({
        configured: true,
        products: data.data || [],
        nextCursor: data.paging?.next ? data.paging?.cursors?.after : null,
      });
    }),
  );
  router.get(
    "/capabilities",
    handle(async (req, res) => {
      user(req);
      res.json({ capabilities, checkedAt: "2026-09-07", blockUsers: true });
    }),
  );
  router.get(
    "/sequence-settings",
    handle(async (req, res) => {
      user(req);
      res.json({
        plan: await defaultSequence(),
        enabled: config.sequenceSchedulerEnabled,
      });
    }),
  );
  router.post(
    "/sequence-media/check",
    handle(async (req, res) => {
      if (user(req).role !== "admin")
        throw bad("Only an admin can check sequence media.", 403);
      res.json({
        media: await inspectSequenceMedia(req.body.media, req.body.type),
      });
    }),
  );
  router.post(
    "/sequence-settings",
    handle(async (req, res) => {
      if (user(req).role !== "admin")
        throw bad("Only an admin can change the default sequence.", 403);
      const steps = validateSequenceSteps(req.body.steps);
      await getDb()
        .collection("settings")
        .doc("chatSequence")
        .set({
          name: String(req.body.name || "Visual Aid Engagement").slice(0, 100),
          steps,
          updatedAt: timestamp(),
        });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:leadId/sequence",
    handle(async (req, res) => {
      const { lead } = await scoped(req);
      res.json({
        lead: await sequenceControl(lead.id, req.body.action, req.body),
      });
    }),
  );
  router.get(
    "/events",
    handle(async (req, res) => {
      const { role } = user(req),
        leadId = String(req.query.leadId || "");
      if (leadId) await leadFor({ ...req, params: { leadId } });
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      let ended = false,
        pending = null,
        heart = null,
        authorizing = false;
      const pendingScopes = new Set();
      const stops = [],
        emit = (event, data) => {
          if (!ended)
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
      const cleanup = () => {
        if (ended) return;
        ended = true;
        clearTimeout(pending);
        clearInterval(heart);
        stops.forEach((stop) => stop());
        res.end();
      };
      const invalidate = (scope = "inbox") => {
        pendingScopes.add(scope);
        if (!pending && !ended)
          pending = setTimeout(() => {
            pending = null;
            emit("change", {
              leadId,
              scopes: [...pendingScopes],
              at: timestamp(),
            });
            pendingScopes.clear();
          }, 180);
      };
      const failed = () => {
        emit("error", { message: "Live updates interrupted. Reconnecting…" });
        cleanup();
      };
      let query = getDb().collection("leads");
      if (role !== "admin")
        query = query.where(
          "assignedTo",
          "in",
          role === "ankit" ? ["ankit", "pinky"] : [role],
        );
      stops.push(
        query
          .orderBy("lastMessageAt", "desc")
          .limit(100)
          .onSnapshot(() => invalidate("inbox"), failed),
      );
      if (leadId) {
        stops.push(
          getDb()
            .collection("leads")
            .doc(leadId)
            .onSnapshot((snap) => {
              const owner =
                snap.data()?.assignedTo === "pinky"
                  ? "ankit"
                  : snap.data()?.assignedTo;
              if (!snap.exists || (role !== "admin" && owner !== role)) {
                emit("revoked", {});
                cleanup();
              } else invalidate("thread");
            }, failed),
        );
        stops.push(
          getDb()
            .collection("messages")
            .where("leadId", "==", leadId)
            .orderBy("timestamp", "desc")
            .limit(100)
            .onSnapshot(() => invalidate("thread"), failed),
        );
        stops.push(
          getDb()
            .collection("leads")
            .doc(leadId)
            .collection("presence")
            .onSnapshot(() => invalidate("thread"), failed),
        );
      }
      heart = setInterval(async () => {
        if (authorizing) return;
        authorizing = true;
        try {
          if (config.deviceApprovalEnabled && !req.device?.bootstrap) {
            const device = await getDevice(req.device.code);
            if (!device?.approved || device.role !== role) {
              emit("revoked", {});
              cleanup();
              return;
            }
          }
          emit("heartbeat", { at: timestamp() });
        } catch {
          failed();
        } finally {
          authorizing = false;
        }
      }, 15000);
      req.on("close", cleanup);
      res.on("close", cleanup);
      emit("ready", { at: timestamp() });
    }),
  );
  router.post(
    "/:leadId/view",
    handle(async (req, res) => {
      const { lead, key } = await scoped(req);
      res.json({ view: await saveChatView(lead.id, key, req.body) });
    }),
  );
  router.post(
    "/:leadId/unread",
    handle(async (req, res) => {
      const { lead, key } = await scoped(req);
      await getDb()
        .collection("leads")
        .doc(lead.id)
        .set({ manualUnread: { [key]: true } }, { merge: true });
      res.json({ ok: true });
    }),
  );
  router.get(
    "/:leadId/draft",
    handle(async (req, res) => {
      const { lead, key } = await scoped(req);
      res.json({
        text:
          (await userRef(key).collection("drafts").doc(lead.id).get()).data()
            ?.text || "",
      });
    }),
  );
  router.post(
    "/:leadId/draft",
    handle(async (req, res) => {
      const { lead, key } = await scoped(req),
        text = String(req.body.text || "");
      if (text.length > 10000) throw bad("Draft is too long.");
      await userRef(key)
        .collection("drafts")
        .doc(lead.id)
        .set({ text, updatedAt: timestamp() });
      res.json({ ok: true });
    }),
  );
  router.get(
    "/:leadId/search",
    handle(async (req, res) => {
      const { lead } = await scoped(req);
      res.json(await searchHistory(lead.id, req.query));
    }),
  );
  router.post(
    "/:leadId/messages/:messageId/visibility",
    handle(async (req, res) => {
      const { lead } = await scoped(req),
        message = await getMessage(req.params.messageId);
      if (message?.leadId !== lead.id || !message.media)
        throw bad("Attachment not found.", 404);
      await getDb()
        .collection("messages")
        .doc(message.id)
        .set({ mediaHidden: req.body.hidden === true }, { merge: true });
      res.json({ ok: true });
    }),
  );
  router.get(
    "/:leadId/team",
    handle(async (req, res) => {
      const { lead, key } = await scoped(req),
        ref = getDb().collection("leads").doc(lead.id);
      const [notes, presence] = await Promise.all([
        ref.collection("notes").orderBy("createdAt", "desc").limit(100).get(),
        ref.collection("presence").get(),
      ]);
      res.json({
        notes: notes.docs.map((d) => ({ id: d.id, ...d.data() })),
        presence: presence.docs
          .filter(
            (d) => d.id !== key && Date.parse(d.data().expiresAt) > Date.now(),
          )
          .map((d) => ({
            agent: d.data().agent,
            expiresAt: d.data().expiresAt,
          })),
      });
    }),
  );
  router.post(
    "/:leadId/notes",
    handle(async (req, res) => {
      const { lead, role } = await scoped(req),
        text = String(req.body.text || "").trim(),
        id = String(req.body.id || "");
      if (!text || text.length > 4000 || !/^[a-zA-Z0-9_-]{8,100}$/.test(id))
        throw bad("Enter a note of up to 4,000 characters.");
      const ref = getDb()
          .collection("leads")
          .doc(lead.id)
          .collection("notes")
          .doc(id),
        note = { text, agent: role, createdAt: timestamp() };
      try {
        await ref.create(note);
      } catch (error) {
        if (error.code !== 6) throw error;
      }
      res.json({ note: { id, ...(await ref.get()).data() } });
    }),
  );
  router.post(
    "/:leadId/presence",
    handle(async (req, res) => {
      const { lead, role, key } = await scoped(req);
      await getDb()
        .collection("leads")
        .doc(lead.id)
        .collection("presence")
        .doc(key)
        .set({
          agent: role,
          expiresAt: new Date(
            Date.now() + (req.body.active ? 25000 : 0),
          ).toISOString(),
        });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:leadId/assign",
    handle(async (req, res) => {
      const { lead, role } = await scoped(req);
      if (role !== "admin")
        throw bad("Only an admin can reassign contacts.", 403);
      if (!config.salesTeam.includes(req.body.assignedTo))
        throw bad("Choose an agent from your team.");
      await updateLead(lead.id, { assignedTo: req.body.assignedTo });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:leadId/ai",
    handle(async (req, res) => {
      const { lead } = await scoped(req),
        enabled = req.body.enabled === true;
      if (
        enabled &&
        (lead.optedOut ||
          lead.whatsappBlocked ||
          ["lost", "converted"].includes(lead.status))
      )
        throw bad(
          "Reopen this lead and resolve opt-out/block status before enabling AI.",
          409,
        );
      await updateLead(lead.id, {
        aiEnabled: enabled,
        lastHumanTouchAt: enabled ? null : timestamp(),
        ...(!enabled && lead.sequenceStatus === "active"
          ? { sequenceStatus: "paused", sequenceStopReason: "manual_handling" }
          : {}),
      });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:leadId/suggest",
    handle(async (req, res) => {
      const { lead } = await scoped(req),
        messages = await getRecentMessages(lead.id, 20),
        last = messages.filter((m) => m.role === "user").at(-1);
      if (!last) throw bad("A customer message is needed to suggest a reply.");
      const { runLeadAgent } = await import("../services/aiAgent.js");
      const result = await runLeadAgent({
        lead,
        recentMessages: messages,
        customerMessage: last.text,
      });
      // Suggestions never update lead state or send a WhatsApp message.
      await leadFor(req);
      res.json({ text: String(result.reply || "").slice(0, 4096) });
    }),
  );
  router.post(
    "/:leadId/typing",
    handle(async (req, res) => {
      const { lead, key } = await scoped(req);
      assertCanSend(lead);
      const message = await getMessage(String(req.body.messageId || ""));
      if (
        message?.leadId !== lead.id ||
        message.role !== "user" ||
        !message.whatsappMessageId
      )
        throw bad("An incoming message is required.");
      const ref = userRef(key).collection("typing").doc(lead.id);
      const permitted = await getDb().runTransaction(async (tx) => {
        const old = await tx.get(ref);
        if (Date.now() - Number(old.data()?.at || 0) < 10000) return false;
        tx.set(ref, { at: Date.now() });
        return true;
      });
      if (permitted) await sendTypingIndicator(message.whatsappMessageId);
      res.json({ ok: true });
    }),
  );
  installSendingRoutes(router, { scoped, leadFor, handle, assertCanSend });
}

function installSendingRoutes(
  router,
  { scoped, leadFor, handle, assertCanSend },
) {
  router.post(
    "/:leadId/forward",
    handle(async (req, res) =>
      res.json(await forwardMessages(req, { leadFor, assertCanSend })),
    ),
  );
  router.post(
    "/:leadId/orders/:messageId",
    handle(async (req, res) => {
      const { lead } = await scoped(req),
        message = await getMessage(req.params.messageId);
      if (message?.leadId !== lead.id || !message.order)
        throw bad("Order not found.", 404);
      if (
        !["received", "confirmed", "fulfilled", "cancelled"].includes(
          req.body.status,
        )
      )
        throw bad("Choose a valid order status.");
      await getDb()
        .collection("messages")
        .doc(message.id)
        .set(
          { orderStatus: req.body.status, orderUpdatedAt: timestamp() },
          { merge: true },
        );
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:leadId/send-structured",
    handle(async (req, res) => {
      const { lead } = await scoped(req),
        type = String(req.body.type || "");
      if (lead.optedOut || lead.whatsappBlocked)
        throw bad(
          "This customer cannot receive messages until their opt-out/block is resolved.",
          409,
        );
      if (type !== "template") assertCanSend(lead);
      const payload = await buildStructuredPayload(type, req.body, lead);
      const key = String(req.body.clientMessageId || ""),
        fingerprint = messageKey(JSON.stringify(payload));
      const claim = await claimOutbound(lead.id, key, fingerprint);
      if (claim.existing) return res.json({ message: claim.existing });
      try {
        await leadFor(req); // Recheck assignment after template/catalogue lookups.
        await updateLead(lead.id, {
          aiEnabled: false,
          lastHumanTouchAt: timestamp(),
          ...(lead.sequenceStatus === "active"
            ? { sequenceStatus: "paused", sequenceStopReason: "human_reply" }
            : {}),
        });
        const result = await sendStructuredMessage(lead.phone, payload.body);
        const whatsappMessageId = result.messages?.[0]?.id;
        if (!whatsappMessageId)
          throw new Error("WhatsApp did not return a message ID.");
        await claim.ref.set(
          { state: "accepted", whatsappMessageId, updatedAt: timestamp() },
          { merge: true },
        );
        const message = await recordMessage({
          leadId: lead.id,
          phone: lead.phone,
          role: "sales",
          type: payload.type,
          text: payload.text,
          ...payload.record,
          whatsappMessageId,
          clientMessageId: key,
          status: "accepted",
        });
        if (
          payload.type === "template" &&
          (String(payload.record?.template?.category || "").toUpperCase() ===
            "MARKETING" ||
            /(?:^|_)marketing(?:_|$)/i.test(
              String(payload.record?.template?.name || ""),
            ))
        ) {
          const sentAt = timestamp();
          await updateLead(lead.id, {
            lastMarketingSentAt: sentAt,
            lastMarketingTemplate: payload.record.template.name,
            marketingAwaitingReply: true,
            marketingReplyPending: false,
          });
        }
        await claim.ref.set({ state: "sent", message }, { merge: true });
        res.json({ message });
      } catch (error) {
        await claim.ref
          .set(
            { state: "unknown", error: String(error.message).slice(0, 300) },
            { merge: true },
          )
          .catch(() => {});
        throw bad(
          "Delivery could not be confirmed. Refresh before sending again. " +
            String(error.message).slice(0, 250),
          502,
        );
      }
    }),
  );
  router.post(
    "/:leadId/block",
    handle(async (req, res) => {
      const { lead } = await scoped(req),
        blocked = req.body.blocked === true;
      const result = await graphApi(
        `${config.whatsappPhoneNumberId}/block_users`,
        {
          method: blocked ? "POST" : "DELETE",
          body: {
            messaging_product: "whatsapp",
            block_users: [{ user: lead.phone }],
          },
        },
      );
      const changed =
        result.block_users?.[blocked ? "added_users" : "removed_users"] || [];
      if (
        !changed.some(
          (u) => String(u.wa_id || u.input).replace(/\D/g, "") === lead.phone,
        )
      )
        throw bad("WhatsApp did not confirm this block change.", 502);
      await updateLead(lead.id, {
        whatsappBlocked: blocked,
        ...(blocked
          ? {
              aiEnabled: false,
              sequenceStatus: "paused",
              sequenceStopReason: "whatsapp_blocked",
            }
          : {}),
      });
      res.json({ ok: true, blocked });
    }),
  );
}

export async function buildStructuredPayload(type, input, lead) {
  if (type === "reaction") {
    const original = await getMessage(String(input.messageId || "")),
      emoji = String(input.emoji || "");
    if (
      original?.leadId !== lead.id ||
      !original.whatsappMessageId ||
      original.type === "reaction"
    )
      throw bad("Choose a WhatsApp message to react to.");
    if (Date.now() - Date.parse(original.timestamp) > 30 * 86400000)
      throw bad("Reactions require a message from the last 30 days.");
    if (
      emoji.length > 24 ||
      (emoji &&
        [
          ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
            emoji,
          ),
        ].length !== 1)
    )
      throw bad("Choose one emoji.");
    const reaction = { message_id: original.whatsappMessageId, emoji };
    return { body: { type, reaction }, type, text: "", record: { reaction } };
  }
  if (type === "contacts") {
    const name = String(input.name || "")
        .trim()
        .slice(0, 100),
      phone = cleanPhone(input.phone);
    if (!name) throw bad("Enter the contact name.");
    const contacts = [
      {
        name: { formatted_name: name, first_name: name },
        phones: [{ phone: "+" + phone, type: "CELL" }],
      },
    ];
    return { body: { type, contacts }, type, text: "", record: { contacts } };
  }
  if (type === "location") {
    const latitude = Number(input.latitude),
      longitude = Number(input.longitude);
    if (
      input.latitude === "" ||
      input.longitude === "" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      throw bad("Enter valid latitude and longitude.");
    const location = {
      latitude,
      longitude,
      name: String(input.name || "").slice(0, 100),
      address: String(input.address || "").slice(0, 250),
    };
    return {
      body: { type, location },
      type,
      text: location.name,
      record: { location },
    };
  }
  if (type === "product") {
    if (!config.whatsappCatalogId)
      throw bad("Product catalogue is not connected.", 409);
    const id = String(input.productId || "");
    if (!/^\d+$/.test(id)) throw bad("Choose a catalogue product.");
    const product = await graphApi(id, {
      query: { fields: "id,name,retailer_id,product_catalog" },
    });
    if (String(product.product_catalog?.id) !== config.whatsappCatalogId)
      throw bad("Product is not in the connected catalogue.");
    return {
      body: {
        type: "interactive",
        interactive: {
          type: "product",
          body: { text: String(input.text || product.name).slice(0, 1024) },
          action: {
            catalog_id: config.whatsappCatalogId,
            product_retailer_id: product.retailer_id,
          },
        },
      },
      type: "product",
      text: product.name,
      record: {
        product: { id, retailerId: product.retailer_id, name: product.name },
      },
    };
  }
  if (type === "template") {
    if (!config.whatsappBusinessAccountId)
      throw bad(
        "Connect your WhatsApp Business Account to load templates.",
        409,
      );
    const id = String(input.templateId || "");
    if (!/^\d+$/.test(id)) throw bad("Choose an approved template.");
    // Fetch through the configured account to prevent templates from another account being selected.
    const list = await graphApi(
      `${config.whatsappBusinessAccountId}/message_templates`,
      {
        query: {
          name: String(input.name || "").slice(0, 512),
          fields: "id,name,language,category,status,components",
          limit: 100,
        },
      },
    );
    const template = list.data?.find(
      (t) => t.id === id && t.status === "APPROVED",
    );
    if (!template) throw bad("Template is not approved for this business.");
    if (
      !lead.lastInboundAt &&
      !lead.consentRecordedAt &&
      input.consent !== true
    )
      throw bad(
        "Confirm that this customer agreed to receive business messages.",
      );
    const components = [],
      values = input.parameters || {};
    for (const component of template.components || []) {
      if (component.type === "BUTTONS") {
        for (const [index, b] of (component.buttons || []).entries()) {
          if (b.type === "URL" && /\{\{/.test(b.url || "")) {
            const text = String(values[`BUTTON:${index}`] || "").trim();
            if (!text || text.length > 1024)
              throw bad("Enter the dynamic button value.");
            components.push({
              type: "button",
              sub_type: "url",
              index: String(index),
              parameters: [{ type: "text", text }],
            });
          } else if (
            b.type === "OTP" ||
            b.type === "FLOW" ||
            b.type === "COPY_CODE"
          )
            throw bad(
              "This specialised template needs its dedicated integration.",
            );
        }
      }
      if (!["HEADER", "BODY"].includes(component.type)) continue;
      if (component.type === "HEADER" && component.format !== "TEXT") {
        const format = String(component.format || "").toLowerCase(),
          mediaId = String(input.headerMediaId || "");
        if (
          !["image", "video", "document"].includes(format) ||
          !/^\d+$/.test(mediaId)
        )
          throw bad("Upload the required template header file.");
        const upload = (
          await getDb().collection("chatUploads").doc(mediaId).get()
        ).data();
        if (
          !upload ||
          upload.leadId !== lead.id ||
          upload.type !== format ||
          Date.now() - Date.parse(upload.createdAt) > 86400000
        )
          throw bad("Choose a fresh header attachment for this contact.");
        components.push({
          type: "header",
          parameters: [
            {
              type: format,
              [format]: {
                id: mediaId,
                ...(format === "document" ? { filename: upload.filename } : {}),
              },
            },
          ],
        });
        continue;
      }
      const names = [
        ...new Set(
          [...String(component.text || "").matchAll(/\{\{([^}]+)\}\}/g)].map(
            (m) => m[1],
          ),
        ),
      ];
      const parameters = names.map((name) => {
        const text = String(values[`${component.type}:${name}`] || "").trim();
        if (!text || text.length > 1024)
          throw bad(
            `Enter a value for ${component.type.toLowerCase()} ${name}.`,
          );
        return {
          type: "text",
          text,
          ...(!/^\d+$/.test(name) ? { parameter_name: name } : {}),
        };
      });
      if (parameters.length)
        components.push({ type: component.type.toLowerCase(), parameters });
    }
    let text =
      template.components?.find((c) => c.type === "BODY")?.text ||
      template.name;
    text = text.replace(/\{\{([^}]+)\}\}/g, (_, name) =>
      String(values[`BODY:${name}`] || ""),
    );
    return {
      body: {
        type,
        template: {
          name: template.name,
          language: { code: template.language },
          ...(components.length ? { components } : {}),
        },
      },
      type,
      text,
      record: {
          template: {
            id: template.id,
            name: template.name,
            language: template.language,
            category: template.category || "",
          },
      },
    };
  }
  throw bad("Unsupported message type.");
}
