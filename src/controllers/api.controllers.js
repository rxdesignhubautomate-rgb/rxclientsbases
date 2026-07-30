import { listQuery } from "../utils/pagination.js";
import { sendData, sendList } from "../utils/http.js";
import { enforceAssignment } from "../middleware/authorize.js";
import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";
import { ConflictError } from "../utils/errors.js";
import { ensureWhatsAppChannelAccount } from "../bootstrap/whatsapp-channel-account.js";
import { CLIENT_SCOPES, relationshipTypesForScope } from "../utils/client-scope.js";

export function createControllers(container) {
  const c = container;
  const actor = (req) => req.auth;
  const org = (req) => req.auth.orgId;
  const booleanQuery = (value) => value === "true" ? true : value === "false" ? false : undefined;
  const scopedOptions = (req) => {
    const options = listQuery(req.query);
    if (req.auth.role === "SALES") {
      const relationshipTypes = relationshipTypesForScope(req.auth.clientScope);
      if (relationshipTypes.length) {
        options.relationshipTypes = relationshipTypes;
        options.relationshipType = null;
        options.assignedTo = null;
      } else {
        options.assignedTo = req.auth.userId;
      }
    }
    return options;
  };
  const checkAssigned = async (req, entity) => {
    let scopedEntity = entity;
    if (
      req.auth.role === "SALES"
      && req.auth.clientScope !== CLIENT_SCOPES.ASSIGNED
      && entity?.contactId
      && !entity.relationshipType
      && !entity.contactRelationshipType
    ) {
      scopedEntity = await c.contacts.get(org(req), entity.contactId);
    }
    enforceAssignment(scopedEntity)(req);
  };
  const resolveOrderReference = async (orgId, contactId, values = {}) => {
    if (values.order_id) return values.order_id;
    const reference = String(values.order_reference || "").trim();
    if (!reference) return undefined;
    const result = await c.store.find(COLLECTIONS.orders, {
      filters: [["orgId", "==", orgId], ["contactId", "==", contactId]],
      limit: 250
    });
    const order = result.items.find((item) => (
      item.orderId === reference
      || item.orderNumber === reference
      || `ORD-${String(item.orderId || "").slice(-8).toUpperCase()}` === reference
    ));
    return order?.orderId || reference;
  };
  const inboxMessages = async (orgId, result) => {
    const attachmentIds = [...new Set(result.items.flatMap((item) => item.attachmentIds || []))];
    const quotedIds = [...new Set(result.items.map((item) => item.replyToMessageId).filter(Boolean))];
    const [attachmentEntries, quotedMessages] = await Promise.all([
      Promise.all(attachmentIds.map(async (attachmentId) => {
        try {
          return [attachmentId, await c.media.get(orgId, attachmentId, { withSignedUrl: true })];
        } catch {
          return [attachmentId, null];
        }
      })),
      c.store.getMany
        ? c.store.getMany(COLLECTIONS.messages, quotedIds)
        : Promise.all(quotedIds.map((messageId) => c.store.get(COLLECTIONS.messages, messageId)))
    ]);
    const attachmentById = new Map(attachmentEntries);
    const quotedById = new Map(quotedMessages.filter(Boolean).map((item) => [item.messageId || item.id, item]));
    return {
      ...result,
      items: result.items.map((item) => {
        const quoted = quotedById.get(item.replyToMessageId);
        return {
          ...item,
          attachments: (item.attachmentIds || []).map((id) => attachmentById.get(id)).filter(Boolean),
          replyTo: quoted ? {
            messageId: quoted.messageId || quoted.id,
            direction: quoted.direction,
            type: quoted.type,
            text: quoted.text || "",
            senderType: quoted.senderType || null
          } : null
        };
      })
    };
  };

  return {
    contacts: {
      create: wrap(async (req, res) => {
        const scopedTypes = relationshipTypesForScope(req.auth.clientScope);
        const input = req.auth.role === "SALES"
          ? {
            ...req.body,
            relationshipType: scopedTypes[0] || req.body.relationshipType,
            assignedTo: req.auth.userId,
            salesPersonName: req.body.salesPersonName || req.user?.name || ""
          }
          : req.body;
        return sendData(res, await c.contacts.create(org(req), input, actor(req)), 201);
      }),
      list: wrap(async (req, res) => sendList(res, await c.contacts.list(org(req), scopedOptions(req)))),
      count: wrap(async (req, res) => sendData(res, await c.contacts.count(org(req), scopedOptions(req)))),
      get: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        await checkAssigned(req, value);
        return sendData(res, value);
      }),
      overview: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        await checkAssigned(req, value);
        return sendData(res, await c.contacts.overview(org(req), req.params.contactId));
      }),
      update: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        await checkAssigned(req, value);
        return sendData(res, await c.contacts.update(org(req), req.params.contactId, req.body, actor(req)));
      }),
      merge: wrap(async (req, res) => sendData(res, await c.contacts.merge(org(req), req.params.contactId, req.body.duplicateContactId, actor(req)))),
      timeline: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        await checkAssigned(req, value);
        return sendData(res, await c.timeline.forContact(org(req), req.params.contactId, Number(req.query.limit) || 100));
      }),
      addIdentity: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        await checkAssigned(req, value);
        return sendData(res, await c.contacts.addIdentity(org(req), req.params.contactId, req.body, actor(req)), 201);
      }),
      listIdentities: wrap(async (req, res) => {
        const value = await c.contacts.get(org(req), req.params.contactId);
        await checkAssigned(req, value);
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
        await checkAssigned(req, contact);
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
          contactRelationshipType: contact.relationshipType || "PROSPECT",
          assignedTo: contact.assignedTo || (req.auth.role === "SALES" ? req.auth.userId : null)
        });
        return sendData(res, conversation, 201);
      }),
      list: wrap(async (req, res) => sendList(res, await c.conversations.list(org(req), scopedOptions(req)))),
      get: wrap(async (req, res) => {
        const value = await c.conversations.get(org(req), req.params.conversationId);
        await checkAssigned(req, value);
        return sendData(res, value);
      }),
      messages: wrap(async (req, res) => {
        const value = await c.conversations.get(org(req), req.params.conversationId);
        await checkAssigned(req, value);
        const result = await c.messages.list(org(req), req.params.conversationId, listQuery(req.query));
        return sendList(res, await inboxMessages(org(req), result));
      }),
      action: (action) => wrap(async (req, res) => {
        const value = await c.conversations.get(org(req), req.params.conversationId);
        await checkAssigned(req, value);
        return sendData(res, await c.conversations.transition(org(req), req.params.conversationId, action, req.body, actor(req)));
      }),
      note: wrap(async (req, res) => sendData(res, await c.messages.createInternalNote(org(req), req.params.conversationId, req.body.note, actor(req)), 201))
    },
    messages: {
      send: wrap(async (req, res) => {
        const conversation = await c.conversations.get(org(req), req.params.conversationId);
        await checkAssigned(req, conversation);
        if (req.body.type === "TEMPLATE") {
          const template = c.templateRegistry.resolve(req.body.utilityTemplateId, "UTILITY");
          const values = req.body.templateVariables || {};
          const orderId = await resolveOrderReference(org(req), conversation.contactId, values);
          const result = await c.smartMessages.smartSend(org(req), {
            contactId: conversation.contactId,
            conversationId: conversation.conversationId,
            eventType: template.eventType || template.key,
            messageIntent: "Transactional customer update",
            isPromotional: false,
            requestedByCustomer: true,
            requestedMode: "UTILITY_TEMPLATE",
            orderId,
            quotationId: values.quotation_id,
            trackingDetails: values.tracking_details || values.tracking_reference,
            templateKey: req.body.utilityTemplateId,
            templateData: values,
            idempotencyKey: req.headers["idempotency-key"],
            metadata: req.body.metadata
          }, actor(req));
          if (req.body.draftMessageId && result.messageId) {
            await c.store.update(COLLECTIONS.messages, req.body.draftMessageId, {
              status: "CANCELLED",
              approvedAsMessageId: result.messageId,
              updatedAt: now()
            });
          }
          return sendData(res, result, 202);
        }
        const result = await c.smartMessages.smartSend(org(req), {
          contactId: conversation.contactId,
          conversationId: conversation.conversationId,
          eventType: "CUSTOMER_REQUEST",
          messageIntent: "Reply to customer",
          requestedByCustomer: true,
          textMessage: req.body.text,
          messageType: req.body.type,
          attachmentIds: req.body.attachmentIds,
          replyToMessageId: req.body.replyToMessageId || null,
          idempotencyKey: req.headers["idempotency-key"],
          metadata: { ...req.body.metadata, replyToMessageId: req.body.replyToMessageId || null }
        }, actor(req));
        if (req.body.draftMessageId && result.messageId) {
          await c.store.update(COLLECTIONS.messages, req.body.draftMessageId, {
            status: "CANCELLED",
            approvedAsMessageId: result.messageId,
            updatedAt: now()
          });
        }
        return sendData(res, result, 202);
      }),
      get: wrap(async (req, res) => {
        const message = await c.messages.get(org(req), req.params.messageId);
        await checkAssigned(req, await c.conversations.get(org(req), message.conversationId));
        const enriched = await inboxMessages(org(req), { items: [message] });
        return sendData(res, enriched.items[0]);
      }),
      retry: wrap(async (req, res) => {
        const message = await c.messages.get(org(req), req.params.messageId);
        await checkAssigned(req, await c.conversations.get(org(req), message.conversationId));
        return sendData(res, await c.messages.retry(org(req), req.params.messageId, actor(req)), 202);
      }),
      retryMedia: wrap(async (req, res) => {
        const message = await c.messages.get(org(req), req.params.messageId);
        await checkAssigned(req, await c.conversations.get(org(req), message.conversationId));
        return sendData(res, await c.media.retryInboundMedia(org(req), req.params.messageId), 200);
      }),
      markRead: wrap(async (req, res) => sendData(res, await c.messages.markRead(org(req), req.params.messageId, actor(req))))
    },
    whatsapp: {
      utilityTemplates: wrap(async (req, res) => {
        const templates = await Promise.all(c.utilityTemplates.list().map(async (template) => {
          const registry = await c.templateRegistry.getStatus(org(req), template.name, template.languageCode);
          return {
            ...template,
            approvalStatus: registry?.status || "NOT_SYNCED",
            approved: registry?.status === "APPROVED",
            rejectedReason: registry?.rejectedReason || null
          };
        }));
        return sendData(res, templates);
      }),
      capabilities: wrap(async (req, res) => {
        let account = null;
        let accountError = null;
        try {
          account = await c.channelAccounts.resolveForSend(org(req), "WHATSAPP", null);
        } catch (error) {
          accountError = error.message;
          if (c.env.AUTO_CONFIGURE_WHATSAPP_CHANNEL_ACCOUNT && org(req) === c.env.ORG_ID) {
            try {
              const result = await ensureWhatsAppChannelAccount(c, actor(req));
              account = result.account;
              accountError = null;
            } catch (configurationError) {
              accountError = configurationError.message;
            }
          }
        }
        return sendData(res, {
          connected: Boolean(account),
          account: account ? {
            channelAccountId: account.channelAccountId || account.id,
            displayName: account.displayName,
            displayNumber: account.displayNumber || "",
            provider: account.provider,
            status: account.status,
            sendEnabled: account.sendEnabled === true,
            receiveEnabled: account.receiveEnabled === true
          } : null,
          accountError,
          supported: {
            text: true,
            images: true,
            documents: true,
            audioAndVoiceNotes: true,
            video: true,
            location: true,
            contactCards: true,
            quotedReplies: true,
            reactions: true,
            interactiveButtonsAndLists: true,
            approvedTemplates: true,
            flows: true,
            readReceipts: true,
            deliveryStatuses: true,
            multiAgentInbox: true
          },
          externalSetup: {
            coexistence: {
              status: "META_ONBOARDING_REQUIRED",
              detail: "Same-number WhatsApp Business App coexistence depends on Meta eligibility and supported onboarding."
            },
            calling: {
              status: "META_ELIGIBILITY_REQUIRED",
              detail: "WhatsApp Business Calling must be enabled for the business account before CRM call controls can use it."
            }
          },
          unsupported: ["GROUPS", "COMMUNITIES", "PERSONAL_STATUS", "PERSONAL_BROADCAST_LISTS"]
        });
      }),
      listQuickReplies: wrap(async (req, res) => sendList(res, await c.quickReplies.list(org(req), {
        ...listQuery(req.query),
        includeInactive: req.query.includeInactive === "true"
      }))),
      createQuickReply: wrap(async (req, res) => sendData(res, await c.quickReplies.create(org(req), req.body, actor(req)), 201)),
      updateQuickReply: wrap(async (req, res) => sendData(res, await c.quickReplies.update(org(req), req.params.quickReplyId, req.body, actor(req))))
    },
    marketing: {
      templates: wrap(async (_req, res) => sendData(res, c.marketing.listTemplates())),
      listReplied: wrap(async (req, res) => sendList(res, await c.marketing.listRepliedProspects(org(req), {
        ...listQuery(req.query),
        relationshipTypes: scopedOptions(req).relationshipTypes,
        actor: actor(req),
        temperature: req.query.temperature,
        important: booleanQuery(req.query.important),
        repeatMarketing: booleanQuery(req.query.repeatMarketing),
        assignedTo: req.query.assignedTo
      }))),
      updateReplied: wrap(async (req, res) => sendData(res, await c.marketing.updateRepliedProspect(org(req), req.params.contactId, req.body, actor(req)))),
      consent: wrap(async (req, res) => {
        await checkAssigned(req, await c.contacts.get(org(req), req.params.contactId));
        return sendData(res, await c.marketing.recordConsent(org(req), req.params.contactId, req.body, actor(req)));
      }),
      listAudiences: wrap(async (req, res) => sendList(res, await c.marketing.listAudiences(org(req), { ...listQuery(req.query), actor: actor(req) }))),
      createAudience: wrap(async (req, res) => sendData(res, await c.marketing.createAudience(org(req), req.body, actor(req)), 201)),
      createAudienceBatches: wrap(async (req, res) => sendData(res, await c.marketing.createSegmentBatches(org(req), req.body, actor(req)), 201)),
      getAudience: wrap(async (req, res) => sendData(res, await c.marketing.getAudience(org(req), req.params.audienceId, { actor: actor(req) }))),
      updateAudience: wrap(async (req, res) => sendData(res, await c.marketing.updateAudience(org(req), req.params.audienceId, req.body, actor(req)))),
      listCampaigns: wrap(async (req, res) => sendList(res, await c.marketing.listCampaigns(org(req), { ...listQuery(req.query), status: req.query.status, actor: actor(req) }))),
      createCampaign: wrap(async (req, res) => sendData(res, await c.marketing.createCampaign(org(req), req.body, actor(req)), 201)),
      getCampaign: wrap(async (req, res) => sendData(res, await c.marketing.getCampaign(org(req), req.params.campaignId, { includeEnrollments: true, actor: actor(req) }))),
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
      summary: wrap(async (req, res) => sendData(res, await c.dashboard.summary(org(req), scopedOptions(req)))),
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
      get: wrap(async (req, res) => {
        const attachment = await c.media.get(org(req), req.params.attachmentId, { withSignedUrl: true });
        if (attachment.purpose !== "MARKETING_ASSET") {
          await checkAssigned(req, await c.contacts.get(org(req), attachment.contactId));
        }
        return sendData(res, attachment);
      }),
      content: wrap(async (req, res) => {
        const { attachment, buffer } = await c.media.getContent(org(req), req.params.attachmentId);
        if (attachment.purpose !== "MARKETING_ASSET") {
          await checkAssigned(req, await c.contacts.get(org(req), attachment.contactId));
        }
        const filename = safeDownloadName(attachment.originalFilename || attachment.attachmentId);
        const disposition = req.query.download === "true" ? "attachment" : "inline";
        res.set({
          "Content-Type": attachment.mimeType || "application/octet-stream",
          "Content-Length": String(buffer.length),
          "Content-Disposition": `${disposition}; filename="${filename.ascii}"; filename*=UTF-8''${filename.encoded}`,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff"
        });
        return res.send(buffer);
      }),
      upload: wrap(async (req, res) => {
        const marketingAsset = req.query.purpose === "MARKETING_ASSET";
        const contactId = marketingAsset ? `MARKETING_${req.auth.userId}` : req.query.contactId;
        if (!marketingAsset) {
          const contact = await c.contacts.get(org(req), contactId);
          await checkAssigned(req, contact);
        }
        const attachment = await c.media.storeBuffer({
          orgId: org(req),
          contactId,
          conversationId: req.query.conversationId || null,
          messageId: null,
          buffer: req.body,
          mimeType: req.headers["content-type"],
          originalFilename: decodeUploadName(req.headers["x-filename"]),
          normalizeForWhatsApp: true,
          purpose: marketingAsset ? "MARKETING_ASSET" : "CHAT_ATTACHMENT",
          createdBy: req.auth.userId
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
        version: "2.9.2",
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
      await checkAssigned(req, value);
      return sendData(res, value);
    }),
    update: wrap(async (req, res) => {
      const before = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      await checkAssigned(req, before);
      return sendData(res, await container.domain.update(resource, req.auth.orgId, req.params[singular], req.body, req.auth));
    }),
    assign: wrap(async (req, res) => {
      const before = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      await checkAssigned(req, before);
      return sendData(res, await container.domain.update(resource, req.auth.orgId, req.params[singular], { assignedTo: req.body.assignedTo }, req.auth, "ASSIGNED"));
    }),
    status: wrap(async (req, res) => {
      const before = await container.domain.get(resource, req.auth.orgId, req.params[singular]);
      await checkAssigned(req, before);
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

function safeDownloadName(value) {
  const original = String(value || "attachment.bin").slice(0, 240);
  return {
    ascii: original.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_"),
    encoded: encodeURIComponent(original)
  };
}

function decodeUploadName(value) {
  const encoded = String(value || "upload.bin");
  try {
    return decodeURIComponent(encoded).slice(0, 240);
  } catch {
    return encoded.slice(0, 240);
  }
}
