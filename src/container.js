import { env } from "./config/env.js";
import { getFirebase } from "./config/firebase.js";
import { logger } from "./config/logger.js";
import { FirestoreStore } from "./repositories/firestore-store.js";
import { AuditService } from "./services/audit.service.js";
import { NotificationService } from "./services/notification.service.js";
import { ContactService } from "./services/contact.service.js";
import { ChannelAccountService } from "./services/channel-account.service.js";
import { ConversationService } from "./services/conversation.service.js";
import { MessageService } from "./services/message.service.js";
import { DomainService } from "./services/domain.service.js";
import { TimelineService } from "./services/timeline.service.js";
import { DashboardService } from "./services/dashboard.service.js";
import { UserService } from "./services/user.service.js";
import { MediaService } from "./services/media.service.js";
import { DocumentService } from "./services/document.service.js";
import { AiService } from "./services/ai.service.js";
import { LegacyDualWriteService } from "./services/legacy-dual-write.service.js";
import { AssignmentService } from "./services/assignment.service.js";
import { WebhookService } from "./services/webhook.service.js";
import { ChannelManager } from "./channels/channel-manager.js";
import { WhatsAppMetaAdapter } from "./channels/whatsapp/whatsapp.adapter.js";
import { WebsiteChannelAdapter } from "./channels/website/website.adapter.js";
import { EmailChannelAdapter } from "./channels/email/email.adapter.js";
import { InboundWorker } from "./workers/inbound.worker.js";
import { OutboundWorker } from "./workers/outbound.worker.js";
import { MediaWorker } from "./workers/media.worker.js";
import { OrderRegisterImportService } from "./services/order-register-import.service.js";
import { OtpMailerService } from "./services/otp-mailer.service.js";
import { OtpAuthService } from "./services/otp-auth.service.js";
import { PasswordAuthService } from "./services/password-auth.service.js";
import { UtilityTemplateService } from "./services/utility-template.service.js";
import { MarketingTemplateService } from "./services/marketing-template.service.js";
import { MarketingService } from "./services/marketing.service.js";
import { TemplateRegistryService } from "./services/template-registry.service.js";
import { SmartMessageService } from "./services/smart-message.service.js";
import { CampaignWorker } from "./workers/campaign.worker.js";
import { QuickReplyService } from "./services/quick-reply.service.js";
import { ProcessOrderSyncService } from "./services/process-order-sync.service.js";
import { QuotationService } from "./services/quotation.service.js";
import { ClientDirectoryService } from "./services/client-directory.service.js";
import { MarketingSafetyService } from "./services/marketing-safety.service.js";
import { CrmMarketingWorkspaceService } from './services/crm-marketing-workspace.service.js';
import { CrmContactTransferService } from './services/crm-contact-transfer.service.js';
import { CrmReportsService } from './services/crm-reports.service.js';
import { CrmClientWorkspaceService } from './services/crm-client-workspace.service.js';
import { CrmBulkClientsService } from './services/crm-bulk-clients.service.js';

let singleton;

export function createContainer(overrides = {}) {
  const firebase = overrides.firebase || (overrides.store ? {} : getFirebase());
  const store = overrides.store || new FirestoreStore(firebase.db);
  const firebaseAuth = overrides.auth || firebase.auth;
  const audit = new AuditService(store);
  const notifications = new NotificationService(store);
  const contacts = new ContactService({ store, audit, notifications });
  const clientDirectory = new ClientDirectoryService({ store, enabled: env.CRM_DIRECTORY_ENABLED, inactivityDays: env.CRM_INACTIVITY_DAYS });
  contacts.classificationEnabled = env.CRM_DIRECTORY_ENABLED;
  const marketingSafety = env.CRM_MARKETING_UPGRADE_ENABLED ? new MarketingSafetyService({ store, directory: clientDirectory, dispatchEnabled: env.CRM_MARKETING_DISPATCH_ENABLED && env.NODE_ENV === 'production' }) : null;
  clientDirectory.marketingSafety = marketingSafety;
  contacts.marketingSafety = marketingSafety;
  const channelAccounts = new ChannelAccountService({ store, audit });
  const conversations = new ConversationService({ store, audit, defaultAiMode: env.AI_DEFAULT_MODE });
  const channelManager = new ChannelManager();
  const whatsappAdapter = overrides.whatsappAdapter || new WhatsAppMetaAdapter({
    accessToken: env.META_ACCESS_TOKEN,
    appSecret: env.META_APP_SECRET,
    graphApiVersion: env.META_GRAPH_API_VERSION,
    requestTimeoutMs: env.META_REQUEST_TIMEOUT_MS,
    allowLiveRequests: env.NODE_ENV === 'production'
  });
  channelManager
    .register("WHATSAPP", "META_CLOUD_API", whatsappAdapter)
    .register("WEBSITE", "INTERNAL", new WebsiteChannelAdapter())
    .register("EMAIL", "UNCONFIGURED", new EmailChannelAdapter());
  const messages = new MessageService({ store, conversations, contacts, channelAccounts, channelManager, audit });
  const domain = new DomainService({ store, audit, orgTimeZone: env.ORG_TIMEZONE });
  const quotations = new QuotationService({ store, domain, audit });
  const imports = new OrderRegisterImportService({ store, contacts, domain, audit });
  const assignment = new AssignmentService(store);
  const timeline = new TimelineService(store);
  const dashboard = new DashboardService(store);
  const users = new UserService({ store, audit });
  const quickReplies = new QuickReplyService({ store, audit });
  const otpMailer = overrides.otpMailer || new OtpMailerService(env);
  const otpAuth = overrides.otpAuth || new OtpAuthService({ store, mailer: otpMailer, env });
  const passwordAuth = overrides.passwordAuth || new PasswordAuthService({ store, auth: firebaseAuth, env });
  const utilityTemplates = overrides.utilityTemplates || new UtilityTemplateService({ overrides: env.WHATSAPP_TEMPLATE_OVERRIDES });
  const marketingTemplates = overrides.marketingTemplates || new MarketingTemplateService({ overrides: env.WHATSAPP_TEMPLATE_OVERRIDES });
  const templateRegistry = overrides.templateRegistry || new TemplateRegistryService({
    store,
    whatsappAdapter,
    businessAccountId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID,
    overrides: env.WHATSAPP_TEMPLATE_OVERRIDES,
    audit
  });
  const smartMessages = overrides.smartMessages || new SmartMessageService({
    store,
    contacts,
    conversations,
    channelAccounts,
    messages,
    utilityTemplates,
    marketingTemplates,
    templateRegistry,
    config: {
      marketingMax24h: env.MARKETING_MAX_24H,
      marketingMax7d: env.MARKETING_MAX_7D,
      marketingMax30d: env.MARKETING_MAX_30D,
      marketingCooldownHours: env.MARKETING_TEMPLATE_COOLDOWN_HOURS,
      idempotencyLockMinutes: env.CAMPAIGN_JOB_LOCK_MINUTES
    }
  });
  const marketing = overrides.marketing || new MarketingService({
    store,
    contacts,
    conversations,
    channelAccounts,
    messages,
    templates: marketingTemplates,
    templateRegistry,
    smartMessages,
    audit,
    config: {
      jobLockMinutes: env.CAMPAIGN_JOB_LOCK_MINUTES,
      maxRetries: env.CAMPAIGN_MAX_RETRIES
    }
  });
  const processOrderSync = overrides.processOrderSync || new ProcessOrderSyncService({
    store,
    contacts,
    marketing,
    audit
  });
  marketing.clientDirectory = clientDirectory;
  marketing.safety = marketingSafety;
  messages.marketingSafety = marketingSafety;
  smartMessages.marketingSafety = marketingSafety;
  const marketingWorkspace = marketingSafety ? new CrmMarketingWorkspaceService({ store, directory: clientDirectory, safety: marketingSafety, templateRegistry, contacts, conversations, channelAccounts, messages, domain }) : null;
  if (marketingWorkspace) marketingWorkspace.transfer = new CrmContactTransferService({ store, directory: clientDirectory, workspace: marketingWorkspace });
  if (marketingWorkspace) marketingWorkspace.reports = new CrmReportsService({ store, directory: clientDirectory, workspace: marketingWorkspace });
  if (marketingWorkspace) marketingWorkspace.clients = new CrmClientWorkspaceService({ store, directory: clientDirectory, workspace: marketingWorkspace });
  clientDirectory.bulk = new CrmBulkClientsService({ store, directory: clientDirectory });
  marketing.workspace = marketingWorkspace;
  if (marketingWorkspace) domain.onOrderChanged = (orgId, orderId) => store.get('orders', orderId).then(order => marketing.attributeOrder(orgId, order.contactId, orderId));
  const media = new MediaService({
    store,
    bucket: overrides.bucket || firebase.bucket,
    channelManager,
    channelAccounts
  });
  const ai = new AiService({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    summaryModel: env.OPENAI_SUMMARY_MODEL,
    autoSendEnabled: env.AI_AUTO_SEND_ENABLED,
    summaryInterval: env.AI_SUMMARY_MESSAGE_INTERVAL,
    store,
    contacts,
    conversations,
    messages,
    smartMessages,
    domain,
    imports,
    notifications,
    client: overrides.aiClient
  });
  const legacyDualWrite = new LegacyDualWriteService(env.ENABLE_LEGACY_DUAL_WRITE && !overrides.disableLegacy);
  const webhook = new WebhookService({
    store,
    orgId: env.ORG_ID,
    whatsappAdapter,
    channelManager,
    channelAccounts,
    contacts,
    conversations,
    messages,
    domain,
    assignment,
    media,
    ai,
    notifications,
    marketing,
    legacyDualWrite,
    allowUnsigned: env.NODE_ENV === "test"
  });
  const documents = new DocumentService({ domain, media, messages, store });
  const inboundWorker = new InboundWorker({
    store,
    webhookService: webhook,
    notifications,
    intervalMs: env.INBOUND_POLL_INTERVAL_MS,
    batchSize: env.INBOUND_BATCH_SIZE,
    workerId: env.WORKER_ID,
    logger
  });
  const outboundWorker = new OutboundWorker({
    store,
    channelManager,
    channelAccounts,
    media,
    notifications,
    intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.MAX_OUTBOX_ATTEMPTS,
    retryDelays: env.OUTBOX_RETRY_DELAYS_MS,
    campaignDelayMs: env.CAMPAIGN_DELAY_MS,
    workerId: env.WORKER_ID,
    logger
  });
  const mediaWorker = new MediaWorker({
    store,
    channelAccounts,
    media,
    notifications,
    intervalMs: env.MEDIA_POLL_INTERVAL_MS,
    batchSize: env.INBOUND_BATCH_SIZE,
    workerId: env.WORKER_ID,
    logger
  });
  const campaignWorker = new CampaignWorker({
    marketing,
    intervalMs: env.CAMPAIGN_POLL_INTERVAL_MS,
    batchSize: env.CAMPAIGN_BATCH_SIZE,
    logger
  });
  messages.onQueued = () => outboundWorker.wake();
  outboundWorker.marketingSafety = marketingSafety;
  outboundWorker.reconcileProviderStatus = (orgId, providerMessageId) => messages.reconcileProviderStatus(orgId, providerMessageId);
  outboundWorker.onAccepted = marketingWorkspace ? (message, tx) => marketingWorkspace.acceptedMessage(message, tx) : null;
  return {
    env,
    firebase,
    auth: firebaseAuth,
    store,
    audit,
    notifications,
    contacts,
    clientDirectory,
    marketingSafety,
    marketingWorkspace,
    channelAccounts,
    conversations,
    messages,
    domain,
    assignment,
    timeline,
    dashboard,
    users,
    quickReplies,
    otpAuth,
    passwordAuth,
    utilityTemplates,
    marketingTemplates,
    templateRegistry,
    smartMessages,
    marketing,
    processOrderSync,
    media,
    documents,
    quotations,
    ai,
    webhook,
    channelManager,
    workers: { inbound: inboundWorker, outbound: outboundWorker, media: mediaWorker, campaign: campaignWorker }
  };
}

export function getContainer() {
  if (!singleton) singleton = createContainer();
  return singleton;
}

export function setContainerForTests(value) {
  singleton = value;
}
