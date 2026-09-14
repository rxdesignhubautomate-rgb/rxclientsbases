import express from 'express';
import { sendData } from '../utils/http.js';
import { assertPermission } from '../services/marketing-safety.service.js';

export function marketingWorkspaceRoutes(service) {
  const router = express.Router(), wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/capabilities', wrap(async (req, res) => {
    assertPermission(req.auth, 'marketing.read');
    return sendData(res, { enabled: true, settings: await service.safety.settings(req.auth.orgId), dispatchConfigured: service.safety.dispatchEnabled, templates: service.templateRegistry.listConfigured().filter(t => t.category === 'MARKETING'), actorId: req.auth.userId });
  }));
  router.patch('/settings', wrap(async (req, res) => sendData(res, await service.safety.setEnabled(req.auth, req.body.enabled, req.body.reason))));
  router.put('/rollout', wrap(async (req, res) => sendData(res, await service.safety.configureRollout(req.auth, req.body))));
  router.get('/overview', wrap(async (req, res) => sendData(res, await service.overview(req.auth))));
  router.get('/lookup', wrap(async (req, res) => sendData(res, await service.clients.lookup(req.auth, req.query))));
  router.get('/pipeline', wrap(async (req, res) => sendData(res, await service.clients.pipeline(req.auth, req.query))));
  router.post('/opportunities', wrap(async (req, res) => sendData(res, await service.clients.openOpportunity(req.auth, req.body), 201)));
  router.post('/contacts/:id/complaints', wrap(async (req, res) => sendData(res, await service.clients.complaint(req.auth, req.params.id, req.body), 201)));
  router.get('/contacts/:id/timeline', wrap(async (req, res) => sendData(res, await service.clients.timeline(req.auth, req.params.id, req.query))));
  router.get('/reports', wrap(async (req, res) => sendData(res, await service.reports.list(req.auth))));
  router.post('/reports', wrap(async (req, res) => sendData(res, await service.reports.create(req.auth, req.body), 201)));
  router.get('/reports/:id', wrap(async (req, res) => sendData(res, await service.reports.get(req.auth, req.params.id))));
  router.post('/reports/:id/advance', wrap(async (req, res) => sendData(res, await service.reports.advance(req.auth, req.params.id, req.body))));
  router.get('/contacts/:id/permission', wrap(async (req, res) => sendData(res, await service.safety.inspect(req.auth.orgId, await service.directory.checkedContact(req.auth, req.params.id)))));
  router.post('/contacts/:id/permission', wrap(async (req, res) => sendData(res, await service.safety.record(req.auth, req.params.id, req.body))));
  for (const kind of ['audiences', 'content', 'campaigns']) {
    router.get(`/${kind}`, wrap(async (req, res) => sendData(res, await service.list(req.auth, kind, req.query))));
    router.get(`/${kind}/:id`, wrap(async (req, res) => sendData(res, await service.get(req.auth, kind, req.params.id))));
  }
  for (const kind of ['audiences', 'content']) router.post(`/${kind}`, wrap(async (req, res) => sendData(res, await service.save(req.auth, kind, req.body), 201)));
  for (const kind of ['audiences', 'content']) router.post(`/${kind}/:id/archive`, wrap(async (req, res) => sendData(res, await service.archive(req.auth, kind, req.params.id, req.body))));
  router.post('/content/:id/approve', wrap(async (req, res) => sendData(res, await service.approveContent(req.auth, req.params.id))));
  router.post('/content/:id/versions', wrap(async (req, res) => sendData(res, await service.save(req.auth, 'content', req.body, req.params.id), 201)));
  router.post('/audiences/:id/versions', wrap(async (req, res) => sendData(res, await service.save(req.auth, 'audiences', req.body, req.params.id), 201)));
  router.put('/audiences/:id/sharing', wrap(async (req, res) => sendData(res, await service.shareAudience(req.auth, req.params.id, req.body))));
  router.get('/audiences/:id/preview', wrap(async (req, res) => sendData(res, await service.previewAudience(req.auth, req.params.id, req.query))));
  router.post('/campaigns', wrap(async (req, res) => sendData(res, await service.createCampaign(req.auth, req.body), 201)));
  router.post('/campaigns/:id/prepare', wrap(async (req, res) => sendData(res, await service.prepareCampaignPage(req.auth, req.params.id))));
  router.get('/campaigns/:id/recipients', wrap(async (req, res) => sendData(res, await service.campaignRecipients(req.auth, req.params.id, req.query))));
  router.post('/campaigns/:id/action', wrap(async (req, res) => sendData(res, await service.campaignAction(req.auth, req.params.id, req.body))));
  router.post('/tasks', wrap(async (req, res) => sendData(res, await service.task(req.auth, req.body), 201)));
  router.get('/tasks', wrap(async (req, res) => sendData(res, await service.dailyTasks(req.auth, req.query))));
  router.patch('/tasks/:id', wrap(async (req, res) => sendData(res, await service.updateTask(req.auth, req.params.id, req.body))));
  router.get('/contacts/:id/history/:kind', wrap(async (req, res) => sendData(res, await service.profileHistory(req.auth, req.params.id, req.params.kind, req.query))));
  router.post('/replies/:id/review', wrap(async (req, res) => sendData(res, await service.reviewReply(req.auth, req.params.id, req.body))));
  router.get('/replies', wrap(async (req, res) => sendData(res, await service.replies(req.auth, req.query))));
  router.post('/messages/:id/reconcile', wrap(async (req, res) => sendData(res, await service.reconcileUnknown(req.auth, req.params.id, req.body))));
  router.get('/rules', wrap(async (req, res) => sendData(res, await service.rules(req.auth))));
  router.put('/rules', wrap(async (req, res) => sendData(res, await service.rules(req.auth, req.body))));
  router.post('/events', wrap(async (req, res) => sendData(res, await service.businessEvent(req.auth, req.body))));
  router.post('/contacts/:id/company', wrap(async (req, res) => sendData(res, await service.linkCompany(req.auth, req.params.id, req.body))));
  router.patch('/contacts/:id/account-review', wrap(async (req, res) => sendData(res, await service.accountReview(req.auth, req.params.id, req.body))));
  router.post('/campaigns/:id/orders', wrap(async (req, res) => sendData(res, await service.linkOrder(req.auth, req.params.id, req.body.orderId))));
  router.get('/campaigns/:id/report', wrap(async (req, res) => sendData(res, await service.report(req.auth, req.params.id))));
  router.get('/campaigns/:id/finance', wrap(async (req, res) => sendData(res, await service.financePage(req.auth, req.params.id, req.query))));
  router.post('/imports/preview', wrap(async (req, res) => sendData(res, await service.transfer.preview(req.auth, req.body))));
  router.post('/imports/commit', wrap(async (req, res) => sendData(res, await service.transfer.commit(req.auth, req.body))));
  router.get('/audiences/:id/export', wrap(async (req, res) => sendData(res, await service.transfer.exportAudiencePage(req.auth, req.params.id, req.query))));
  router.patch('/opportunities/:id/stage', wrap(async (req, res) => sendData(res, await service.stage(req.auth, req.params.id, req.body))));
  return router;
}
