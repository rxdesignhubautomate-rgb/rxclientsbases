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
import { CampaignWorker } from "./workers/campaign.worker.js";

let singleton;

export function createContainer(overrides = {}) {
  const firebase = overrides.firebase || (overrides.store ? {} : getFirebase());
  const store = overrides.store || new FirestoreStore(firebase.db);
  const firebaseAuth = overrides.auth || firebase.auth;
  const audit = new AuditService(store);
  const notifications = new NotificationService(store);
  const contacts = new ContactService({ store, audit, notifications });
  const channelAccounts = new ChannelAccountService({ store, audit });
  const conversations = new ConversationService({ store, audit, defaultAiMode: env.AI_DEFAULT_MODE });
  const channelManager = new ChannelManager();
  const whatsappAdapter = overrides.whatsappAdapter || new WhatsAppMetaAdapter({
    accessToken: env.META_ACCESS_TOKEN,
    appSecret: env.META_APP_SECRET,
    graphApiVersion: env.META_GRAPH_API_VERSION
  });
  channelManager
    .register("WHATSAPP", "META_CLOUD_API", whatsappAdapter)
    .register("WEBSITE", "INTERNAL", new WebsiteChannelAdapter())
    .register("EMAIL", "UNCONFIGURED", new EmailChannelAdapter());
  const messages = new MessageService({ store, conversations, contacts, channelAccounts, channelManager, audit });
  const domain = new DomainService({ store, audit, orgTimeZone: env.ORG_TIMEZONE });
  const imports = new OrderRegisterImportService({ store, contacts, domain, audit });
  const assignment = new AssignmentService(store);
  const timeline = new TimelineService(store);
  const dashboard = new DashboardService(store);
  const users = new UserService({ store, audit });
  const otpMailer = overrides.otpMailer || new OtpMailerService(env);
  const otpAuth = overrides.otpAuth || new OtpAuthService({ store, mailer: otpMailer, env });
  const passwordAuth = overrides.passwordAuth || new PasswordAuthService({ store, auth: firebaseAuth, env });
  const utilityTemplates = overrides.utilityTemplates || new UtilityTemplateService();
  const marketingTemplates = overrides.marketingTemplates || new MarketingTemplateService();
  const marketing = overrides.marketing || new MarketingService({
    store,
    contacts,
    conversations,
    channelAccounts,
    messages,
    templates: marketingTemplates,
    audit
  });
  const media = new MediaService({ store, bucket: overrides.bucket || firebase.bucket, channelManager });
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
  return {
    env,
    firebase,
    auth: firebaseAuth,
    store,
    audit,
    notifications,
    contacts,
    channelAccounts,
    conversations,
    messages,
    domain,
    assignment,
    timeline,
    dashboard,
    users,
    otpAuth,
    passwordAuth,
    utilityTemplates,
    marketingTemplates,
    marketing,
    media,
    documents,
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
