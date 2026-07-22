import { listQuery } from "../utils/pagination.js";
import { sendData, sendList } from "../utils/http.js";
import { enforceAssignment } from "../middleware/authorize.js";
import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";
import { ConflictError } from "../utils/errors.js";

export function createControllers(container) {
  const c = container;
  const actor = (req) => req.auth;
  const org = (req) => req.auth.orgId;
  const scopedOptions = (req) => {
    const options = listQuery(req.query);
    if (req.auth.role === "SALES") options.assignedTo = req.auth.userId;
    return options;
  };
  const checkAssigned = (req, entity) => enforceAssignment(entity)(req);

  return {
    contacts: {
      create: wrap(async (req, res) => {
        const input = req.auth.role === "SALES"
          ? { ...req.body, assignedTo: req.auth.userId, salesPersonName: req.body.salesPersonName || req.user?.name || "" }
          : req.body;
        return sendData(res, await c.contacts.create(org(req), input, actor(req)), 201);
      }),
      list: wrap(async (req, res) => sendList(res, await c.contacts.list(org(req), scopedOptions(req)))),
      get: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        checkAssigned(req, value);
        return sendData(res, value);
      }),
      overview: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        checkAssigned(req, value);
        return sendData(res, await c.contacts.overview(org(req), req.params.contactId));
      }),
      update: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        checkAssigned(req, value);
        return sendData(res, await c.contacts.update(org(req), req.params.contactId, req.body, actor(req)));
      }),
      merge: wrap(async (req, res) => sendData(res, await c.contacts.merge(org(req), req.params.contactId, req.body.duplicateContactId, actor(req)))),
      timeline: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        checkAssigned(req, value);
        return sendData(res, await c.timeline.forContact(org(req), req.params.contactId, Number(req.query.limit) || 100));
      }),
      addIdentity: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        checkAssigned(req, value);
        return sendData(res, await c.contacts.addIdentity(org(req), req.params.contactId, req.body, actor(req)), 201);
      }),
      listIdentities: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        checkAssigned(req, value);
        return sendList(res, await c.contacts.listIdentities(org(req), req.params.contactId));
      }),
      updateIdentity: wrap(async (req, res) => sendData(res, await c.contacts.updateIdentity(org(req), req.params.channelIdentityId, req.body, actor(req))))
    },
    channelAccounts: {
      list: wrap(async (req, res) => sendList(res, await c.channelAccounts.list(org(req), { ...listQuery(req.query), channel: req.query.channel, status: req.query.status }))),
      create: wrap(async (req, res) => sendData(res, await c.channelAccounts.create(org(req), req.body, actor(req)), 201)),
      get: wrap(async (req, res) => sendData(res, await c.channelAccounts.get(org(req), req.params.channelAccountId))),
      update: wrap(async (req, res) => sendData(res, await c.channelAccounts.update(org(req), req.params.channelAccountId, req.body, actor(req)))),
      activate: wrap(async (req, res) => sendData(res, await c.channelAccounts.activate(org(req), req.params.channelAccountId, actor(req)))),
      disable: wrap(async (req, res) => sendData(res, await c.channelAccounts.disable(org(req), req.params.channelAccountId, actor(req)))),
      makeDefault: wrap(async (req, res) => sendData(res, await c.channelAccounts.makeDefault(org(req), req.params.channelAccountId, actor(req))))
    },
    conversations: {
      start: wrap(async (req, res) => {
        const contact = await c.contacts.get(org(req), req.body.contactId);
        checkAssigned(req, contact);
        if (!contact.primaryPhone) throw new ConflictError("Client needs a valid phone number before starting WhatsApp chat");
        const account = await c.channelAccounts.resolveForSend(org(req), "WHATSAPP", null);
        const identities = await c.contacts.listIdentities(org(req), contact.contactId);
        let identity = identities.items.find((item) => item.channel === "WHATSAPP" && item.active === true);
        if (!identity) {
          identity = await c.contacts.addIdentity(org(req), contact.contactId, {
            channel: "WHATSAPP",
            externalUserId: contact.primaryPhone,
            channelAccountId: account.channelAccountId || account.id,
            active: true
          }, actor(req));
        }
        const conversation = await c.conversations.findOrCreate({
          orgId: org(req),
          contactId: contact.contactId,
          channel: "WHATSAPP",
          channelAccountId: identity.channelAccountId || account.channelAccountId || account.id,
          assignedTo: contact.assignedTo || (req.auth.role === "SALES" ? req.auth.userId : null)
        });
        return sendData(res, conversation, 201);
      }),
      list: wrap(async (req, res) => sendList(res, await c.conversations.list(org(req), scopedOptions(req)))),
      get: wrap(async (req, res) => {
        const value = await c.conversations.get(org(req), req.params.conversationId);
        checkAssigned(req, value);
        return sendData(res, value);
      }),
      messages: wrap(async (req, res) => {
        const value = await c.conversations.get(org(req), req.params.conversationId);
        checkAssigned(req, value);
        return sendList(res, await c.messages.list(org(req), req.params.conversationId, listQuery(req.query)));
      }),
      action: (action) => wrap(async (req, res) => {
        const value = await c.conversations.get(org(req), req.params.conversationId);
        checkAssigned(req, value);
        return sendData(res, await c.conversations.transition(org(req), req.params.conversationId, action, req.body, actor(req)));
      }),
      note: wrap(async (req, res) => sendData(res, await c.messages.createInternalNote(org(req), req.params.conversationId, req.body.note, actor(req)), 201))
    },
    messages: {
      send: wrap(async (req, res) => {
        const conversation = await c.conversations.get(org(req), req.params.conversationId);
        checkAssigned(req, conversation);
        const prepared = req.body.type === "TEMPLATE"
          ? c.utilityTemplates.prepare(req.body.utilityTemplateId, req.body.templateVariables)
          : { text: req.body.text, type: req.body.type, metadata: req.body.metadata };
        const result = await c.messages.queueOutbound({
          orgId: org(req),
          conversationId: req.params.conversationId,
          text: prepared.text,
          type: prepared.type,
          attachmentIds: req.body.attachmentIds,
          replyToMessageId: req.body.replyToMessageId,
          metadata: prepared.metadata,
          senderType: "AGENT",
          senderId: req.auth.userId,
          idempotencyKey: req.headers["idempotency-key"]
        });
        if (req.body.draftMessageId) {
          await c.store.update(COLLECTIONS.messages, req.body.draftMessageId, {
            status: "CANCELLED",
            approvedAsMessageId: result.message?.messageId,
            updatedAt: now()
          });
        }
        return sendData(res, result, 202);
      }),
      get: wrap(async (req, res) => {
        const message = await c.messages.get(org(req), req.params.messageId);
        checkAssigned(req, await c.conversations.get(org(req), message.conversationId));
        return sendData(res, message);
      }),
      retry: wrap(async (req, res) => {
        const message = await c.messages.get(org(req), req.params.messageId);
        checkAssigned(req, await c.conversations.get(org(req), message.conversationId));
        return sendData(res, await c.messages.retry(org(req), req.params.messageId, actor(req)), 202);
      }),
      markRead: wrap(async (req, res) => sendData(res, await c.messages.markRead(org(req), req.params.messageId, actor(req))))
    },
    whatsapp: {
      utilityTemplates: wrap(async (_req, res) => sendData(res, c.utilityTemplates.list()))
    },
    marketing: {
      templates: wrap(async (_req, res) => sendData(res, c.marketing.listTemplates())),
      consent: wrap(async (req, res) => sendData(res, await c.marketing.recordConsent(org(req), req.params.contactId, req.body, actor(req)))),
      listAudiences: wrap(async (req, res) => sendList(res, await c.marketing.listAudiences(org(req), listQuery(req.query)))),
      createAudience: wrap(async (req, res) => sendData(res, await c.marketing.createAudience(org(req), req.body, actor(req)), 201)),
      getAudience: wrap(async (req, res) => sendData(res, await c.marketing.getAudience(org(req), req.params.audienceId))),
      updateAudience: wrap(async (req, res) => sendData(res, await c.marketing.updateAudience(org(req), req.params.audienceId, req.body, actor(req)))),
      listCampaigns: wrap(async (req, res) => sendList(res, await c.marketing.listCampaigns(org(req), { ...listQuery(req.query), status: req.query.status }))),
      createCampaign: wrap(async (req, res) => sendData(res, await c.marketing.createCampaign(org(req), req.body, actor(req)), 201)),
      getCampaign: wrap(async (req, res) => sendData(res, await c.marketing.getCampaign(org(req), req.params.campaignId, { includeEnrollments: true }))),
      launchCampaign: wrap(async (req, res) => sendData(res, await c.marketing.launchCampaign(org(req), req.params.campaignId, req.body, actor(req)), 202)),
      pauseCampaign: wrap(async (req, res) => sendData(res, await c.marketing.pauseCampaign(org(req), req.params.campaignId, actor(req)))),
      resumeCampaign: wrap(async (req, res) => sendData(res, await c.marketing.resumeCampaign(org(req), req.params.campaignId, actor(req))))
    },
    leads: resourceController(c, "leads", scopedOptions, checkAssigned),
    quotations: {
      ...resourceController(c, "quotations", scopedOptions, checkAssigned),
      generatePdf: wrap(async (req, res) => sendData(res, await c.documents.generateQuotationPdf(org(req), req.params.quotationId), 201)),
      send: wrap(async (req, res) => sendData(res, await c.documents.sendQuotation(org(req), req.params.quotationId, actor(req)), 202)),
      accept: wrap(async (req, res) => sendData(res, await c.domain.update("quotations", org(req), req.params.quotationId, { status: "ACCEPTED", acceptedAt: now() }, actor(req), "ACCEPTED"))),
      reject: wrap(async (req, res) => sendData(res, await c.domain.update("quotations", org(req), req.params.quotationId, { status: "REJECTED", rejectedAt: now(), rejectionReason: req.body.reason || "" }, actor(req), "REJECTED")))
    },
    followUps: {
      ...resourceController(c, "followUps", scopedOptions, checkAssigned),
      due: wrap(async (req, res) => sendList(res, await c.domain.list("followUps", org(req), { ...scopedOptions(req), status: "SCHEDULED", to: now() }))),
      complete: wrap(async (req, res) => sendData(res, await c.domain.update("followUps", org(req), req.params.followUpId, { status: "COMPLETED", completedAt: now(), outcome: req.body.outcome || "" }, actor(req), "COMPLETED"))),
      reschedule: wrap(async (req, res) => sendData(res, await c.domain.update("followUps", org(req), req.params.followUpId, { status: "SCHEDULED", dueAt: new Date(req.body.dueAt), rescheduleReason: req.body.reason || "" }, actor(req), "RESCHEDULED")))
    },
    orders: {
      ...resourceController(c, "orders", scopedOptions, checkAssigned),
      create: wrap(async (req, res) => {
        const order = await c.domain.create("orders", org(req), req.body, actor(req));
        await c.marketing.attributeOrder(org(req), order.contactId, order.orderId);
        return sendData(res, order, 201);
      }),
      payment: wrap(async (req, res) => sendData(res, await c.domain.addPayment(org(req), req.params.orderId, req.body, actor(req)), 201)),
      assignDesigner: wrap(async (req, res) => sendData(res, await c.domain.update("orders", org(req), req.params.orderId, { designerAssigned: req.body.designerAssigned }, actor(req), "DESIGNER_ASSIGNED"))),
      timeline: wrap(async (req, res) => {
        const order = await c.domain.get("orders", org(req), req.params.orderId);
        return sendData(res, await c.timeline.forEntity(org(req), "order", req.params.orderId, order.contactId));
      })
    },
    dashboard: {
      summary: wrap(async (req, res) => sendData(res, await c.dashboard.summary(org(req)))),
      pipeline: wrap(async (req, res) => sendData(res, await c.dashboard.pipeline(org(req)))),
      followUps: wrap(async (req, res) => sendList(res, await c.dashboard.followUps(org(req), req.auth.role === "SALES" ? req.auth.userId : req.query.assignedTo))),
      performance: wrap(async (req, res) => sendData(res, await c.dashboard.salesPerformance(org(req)))),
      unread: wrap(async (req, res) => sendData(res, await c.dashboard.unreadCounts(org(req))))
    },
    users: {
      list: wrap(async (req, res) => sendList(res, await c.users.list(org(req), listQuery(req.query)))),
      create: wrap(async (req, res) => sendData(res, await c.users.create(org(req), req.body, actor(req)), 201)),
      update: wrap(async (req, res) => sendData(res, await c.users.update(org(req), req.params.userId, req.body, actor(req))))
    },
    attachments: {
      get: wrap(async (req, res) => sendData(res, await c.media.get(org(req), req.params.attachmentId, { withSignedUrl: true }))),
      upload: wrap(async (req, res) => {
        const contact = await c.contacts.get(org(req), req.query.contactId);
        checkAssigned(req, contact);
        const attachment = await c.media.storeBuffer({
          orgId: org(req),
          contactId: req.query.contactId,
          conversationId: req.query.conversationId || null,
          messageId: null,
          buffer: req.body,
          mimeType: req.headers["content-type"],
          originalFilename: req.headers["x-filename"] || "upload.bin"
        });
        return sendData(res, attachment, 201);
      })
    },
    imports: {
      previewOrderRegister: wrap(async (req, res) => sendData(res, c.imports.preview(req.body))),
      commitOrderRegister: wrap(async (req, res) => sendData(res, await c.imports.commit(org(req), req.body, actor(req)), 201))
    },
    system: {
      info: wrap(async (req, res) => sendData(res, {
        service: "rx-communication-crm",
        version: "2.0.0",
        orgId: org(req),
        features: {
          legacyDualWrite: c.env.ENABLE_LEGACY_DUAL_WRITE,
          newCrmReads: c.env.USE_NEW_CRM_READS,
          workers: c.env.WORKERS_ENABLED,
          aiDefaultMode: c.env.AI_DEFAULT_MODE
        }
      }))
    }
  };
}

function resourceController(container, resource, scopedOptions, checkAssigned) {
  const singular = resource === "followUps" ? "followUpId" : `${resource.slice(0, -1)}Id`;
  return {
    create: wrap(async (req, res) => sendData(res, await container.domain.create(resource, req.auth.orgId, req.body, req.auth), 201)),
    list: wrap(async (req, res) => sendList(res, await container.domain.list(resource, req.auth.orgId, scopedOptions(req)))),
    get: wrap(async (req, res) => {
      const value = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      checkAssigned(req, value);
      return sendData(res, value);
    }),
    update: wrap(async (req, res) => {
      const before = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      checkAssigned(req, before);
      return sendData(res, await container.domain.update(resource, req.auth.orgId, req.params[singular], req.body, req.auth));
    }),
    assign: wrap(async (req, res) => {
      const before = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      checkAssigned(req, before);
      return sendData(res, await container.domain.update(resource, req.auth.orgId, req.params[singular], { assignedTo: req.body.assignedTo }, req.auth, "ASSIGNED"));
    }),
    status: wrap(async (req, res) => {
      const before = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      checkAssigned(req, before);
      const field = resource === "leads" ? "leadStatus" : "status";
      return sendData(res, await container.domain.update(resource, req.auth.orgId, req.params[singular], { [field]: req.body.status }, req.auth, "STATUS_CHANGED"));
    }),
    timeline: wrap(async (req, res) => {
      const value = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      return sendData(res, await container.timeline.forEntity(req.auth.orgId, resource.slice(0, -1), req.params[singular], value.contactId));
    })
  };
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
