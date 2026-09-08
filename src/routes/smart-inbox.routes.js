import express from 'express';
import { z } from 'zod';
import { authorizePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { assertInboxAccess, preferenceCollection, preferenceId } from '../services/inbox-access.js';
import { sendData } from '../utils/http.js';
import { now } from '../utils/dates.js';
import { ConflictError } from '../utils/errors.js';

const prefs = z.object({ pinned: z.boolean().optional(), archived: z.boolean().optional(), muted: z.boolean().optional(), manualUnread: z.boolean().optional(), draft: z.string().max(4096).optional(), starredMessageIds: z.array(z.string().max(100)).max(200).optional() }).strict();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function smartInboxRoutes(c) {
  const router = express.Router();
  // Use route-level access checks for every read and mutation.
  const load = async req => {
    const conversation = await c.conversations.get(req.auth.orgId, req.params.id);
    await assertInboxAccess(c, req.auth.orgId, conversation, req.auth);
    return conversation;
  };
  router.get('/conversations/:id/preferences', authorizePermission('conversations.read', 'conversations.read_assigned'), wrap(async (req, res) => {
    await load(req);
    return sendData(res, await c.store.get(preferenceCollection, preferenceId(req.auth.orgId, req.auth.userId, req.params.id)) || {});
  }));
  router.patch('/conversations/:id/preferences', authorizePermission('conversations.read', 'conversations.read_assigned'), validate(prefs), wrap(async (req, res) => {
    const conversation = await load(req);
    const id = preferenceId(req.auth.orgId, req.auth.userId, req.params.id);
    const result = await c.store.runTransaction(async tx => {
      const current = await tx.get(preferenceCollection, id);
      const value = { ...current, ...req.body, orgId: req.auth.orgId, userId: req.auth.userId, conversationId: req.params.id, updatedAt: now() };
      tx.set(preferenceCollection, id, value);
      tx.update('conversations', conversation.conversationId, { updatedAt: now() });
      return value;
    });
    return sendData(res, result);
  }));
  router.post('/conversations/:id/suggest', authorizePermission('messages.send'), wrap(async (req, res) => {
    const conversation = await load(req);
    if (!c.ai?.client) throw new ConflictError('AI suggestions need the server OpenAI configuration. Quick replies are available meanwhile.');
    const [contact, lead, recent] = await Promise.all([
      c.contacts.get(req.auth.orgId, conversation.contactId),
      conversation.leadId ? c.domain.get('leads', req.auth.orgId, conversation.leadId) : null,
      c.messages.list(req.auth.orgId, conversation.conversationId, { limit: 20, sortOrder: 'desc' })
    ]);
    const messages = recent.items.filter(item => item.status !== 'DRAFT');
    const inbound = messages.find(item => item.direction === 'INBOUND');
    if (!inbound) throw new ConflictError('Receive a client message before requesting a reply suggestion.');
    const result = await c.ai.generate({ contact, lead, conversation, recentMessages: messages.reverse(), customerMessage: inbound.text || `[${inbound.type}]` });
    // This endpoint only suggests. It never queues a message or updates client facts.
    return sendData(res, { reply: result.reply, reason: result.reason, needsHuman: result.needsHuman, sourceMessageId: inbound.messageId });
  }));
  return router;
}
