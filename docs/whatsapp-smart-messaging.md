# WhatsApp smart messaging and campaign policy

## Architecture

All user replies, AI auto-replies, transactional event notifications, and campaign jobs pass through the existing durable CRM pipeline:

1. `message-decision.service.js` selects `SERVICE_MESSAGE`, `UTILITY_TEMPLATE`, `MARKETING_TEMPLATE`, or `DO_NOT_SEND` from server-owned data.
2. `smart-message.service.js` verifies the contact, transaction, consent, service window, frequency limits, template status, and idempotency key.
3. Allowed messages are stored in `messages` and `outbox`; no API request sends a large campaign synchronously.
4. `outbound.worker.js` claims jobs transactionally, calls the existing Meta adapter, retries transient failures, and records the Meta message ID.
5. WhatsApp status webhooks update the message, campaign enrollment, campaign counters, contact/lead status, and audit record without double-counting a repeated status.

The Firebase Admin initialization, webhook signature verification, inbound message persistence, AI processing, and existing collection names are reused.

## Environment variables

The original `META_*` variables remain canonical. The documented `WHATSAPP_*` aliases are accepted for access token, phone-number ID, verify token, and WABA ID.

Required for production:

- `META_GRAPH_API_VERSION`
- `META_PHONE_NUMBER_ID` (alias `WHATSAPP_PHONE_NUMBER_ID`)
- `META_WHATSAPP_BUSINESS_ACCOUNT_ID` (alias `WHATSAPP_WABA_ID`)
- `META_ACCESS_TOKEN` (alias `WHATSAPP_ACCESS_TOKEN`)
- `META_VERIFY_TOKEN` (alias `WHATSAPP_VERIFY_TOKEN`)
- `META_APP_SECRET`
- Existing Firebase and authentication environment variables

Policy and worker configuration:

- `META_REQUEST_TIMEOUT_MS=15000`
- `WHATSAPP_TEMPLATE_OVERRIDES_JSON={}`
- `CAMPAIGN_WORKER_MODE=internal` (`external` or `endpoint` are also supported)
- `CAMPAIGN_BATCH_SIZE=20`
- `CAMPAIGN_DELAY_MS=250`
- `CAMPAIGN_MAX_RETRIES=5`
- `CAMPAIGN_JOB_LOCK_MINUTES=15`
- `MARKETING_MAX_24H=1`
- `MARKETING_MAX_7D=3`
- `MARKETING_MAX_30D=8`
- `MARKETING_TEMPLATE_COOLDOWN_HOURS=24`

`ADMIN_API_KEY` is reserved for a future non-user machine caller. Current admin routes use the existing Firebase/CRM authentication and OWNER/ADMIN role checks.

Template names and languages can be changed without editing source code:

```env
WHATSAPP_TEMPLATE_OVERRIDES_JSON={"QUOTATION_READY":{"name":"rx_quotation_ready","language":"en_US"}}
```

## Message policy

- A recorded inbound customer message within 24 hours, or an explicitly recorded free-entry expiry, permits a normal service message.
- Utility is allowed outside the service window only for a whitelisted event backed by a real quotation or order document. Missing identifiers cause `DO_NOT_SEND`.
- Discounts, offers, samples, reactivation, cross-selling, upselling, and campaigns are Marketing. They require recorded opt-in and an APPROVED Marketing template.
- STOP, UNSUBSCRIBE, CANCEL, NOT INTERESTED, NO MORE MESSAGES, BAND KARO, and MESSAGE MAT KARO opt the contact out. The service-window confirmation is sent once and the AI reply is suppressed.
- START, YES, INTERESTED, SEND DETAILS, SEND SAMPLE, and PRICE BHEJO are treated as explicit opt-in only when the complete normalized reply matches one of these phrases.
- Blocked/suppressed contacts, invalid numbers, duplicate events, frequency-limit violations, and PAUSED/REJECTED/DISABLED templates never call Meta.

The system never changes promotional content into Utility to reduce price.

## Template registry

Server-owned template keys are in `src/config/whatsapp-templates.js`. Meta remains the authority for approval and category. Sync the WABA templates after deployment:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/whatsapp/templates/sync" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN"
```

Sending is blocked when the selected template has not been synced or its Meta status is not `APPROVED`.

## Smart message API

Decision-only check:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/message/decide" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"LEAD_DOCUMENT_ID","eventType":"QUOTATION_READY","quotationId":"QUOTATION_DOCUMENT_ID","templateKey":"QUOTATION_READY","templateData":{"customer_name":"Amit","quotation_id":"QT-2026-00125","product":"Visual Aid Book","amount":"12500","quotation_url":"https://example.com/quotation.pdf"}}'
```

The same body can be sent to `POST /api/v1/message/smart-send`. The result states whether it was queued and includes the exact policy reason and audit ID.

## Transaction event examples

Quotation ready:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/events/quotation-ready" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"LEAD_DOCUMENT_ID","quotationId":"QUOTATION_DOCUMENT_ID","customerName":"Amit","product":"Visual Aid Book","quantity":"10","amount":"12500","quotationUrl":"https://example.com/quotation.pdf"}'
```

Design proof ready:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/events/design-proof-ready" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"LEAD_DOCUMENT_ID","orderId":"ORDER_DOCUMENT_ID","proofUrl":"https://example.com/design-proof.pdf"}'
```

Order dispatched:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/events/order-dispatched" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"LEAD_DOCUMENT_ID","orderId":"ORDER_DOCUMENT_ID","courierName":"Delhivery","trackingNumber":"1234567890","trackingUrl":"https://example.com/track"}'
```

## Campaign approval and execution

Bulk campaigns are always Marketing. The strict lifecycle is:

`DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED/RUNNING -> COMPLETED`

Pause, resume, cancel, and failure states are supported. The existing admin-only `/api/v1/marketing/campaigns/:id/launch` route remains compatible and records `LEGACY_ADMIN_LAUNCH` approval; new integrations should use the strict routes below.

Create:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/campaigns" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Interested customer follow-up","audienceId":"AUDIENCE_ID","interestLabel":"visual aid printing","templateId":"interest_followup","steps":[{"delayDays":0,"messageLine":"We can share current options and pricing."}]}'
```

Submit and approve:

```bash
curl -X POST "https://YOUR_RENDER_HOST/api/v1/campaigns/CAMPAIGN_ID/submit" -H "Authorization: Bearer CREATOR_FIREBASE_ID_TOKEN"
curl -X POST "https://YOUR_RENDER_HOST/api/v1/campaigns/CAMPAIGN_ID/approve" -H "Authorization: Bearer ADMIN_FIREBASE_ID_TOKEN"
curl -X POST "https://YOUR_RENDER_HOST/api/v1/campaigns/CAMPAIGN_ID/start" -H "Authorization: Bearer ADMIN_FIREBASE_ID_TOKEN" -H "Content-Type: application/json" -d '{}'
```

The worker re-checks consent, suppression, number validity, template approval, cooldown, frequency, campaign state, and idempotency before every step. Skip/failure reasons remain visible on each enrollment.

## Worker modes

- `internal`: preserves the current single Render web-service behavior.
- `external`: set the web service to this mode and run `npm run worker:campaign` in a separate Render Background Worker.
- `endpoint`: invoke `POST /api/v1/workers/campaign/run` from an authenticated scheduler; the web process does not start the campaign polling loop.

Do not run both `internal` and the external worker for the same deployment. Transactional claims still prevent double processing, but one worker mode is operationally simpler.

## Firestore data

Existing collections are preserved. New collections are:

- `messageAuditLogs`: one transparent policy audit per send decision
- `messageDecisionKeys`: deterministic transaction/idempotency claims
- `templateRegistry`: last Meta template sync and approval state

Existing `messages`, `outbox`, `contacts`, `leads`, `marketingCampaigns`, and `campaignEnrollments` receive additive fields only. Deploy `firestore.indexes.json` before enabling production campaigns.

## Render deployment

1. Push the backend source and lock file.
2. In Render use Build Command `npm ci`, Start Command `npm start`, and Health Check `/health`.
3. Add the required Firebase, Meta, WABA, login, and policy variables from `.env.example`.
4. Deploy Firestore indexes with `firebase deploy --only firestore:indexes`.
5. Deploy/restart Render and verify `/health` and `/ready`.
6. Call the template-sync endpoint and confirm required templates show `APPROVED`.
7. Run `POST /api/v1/message/decide` before the first real send.
8. Keep `AI_AUTO_SEND_ENABLED=false` until service-window decisions and audit records have been reviewed.

## Meta WhatsApp Manager manual steps

1. Create each template using the exact configured name, language, variable order, and correct Utility or Marketing category.
2. Wait for Meta status `APPROVED`; internal CRM approval does not replace Meta template approval.
3. Subscribe the app to inbound `messages` and message-status events.
4. Keep the callback at `/webhooks/whatsapp` and configure the same verify token used by Render.
5. Confirm `META_APP_SECRET` is present so `X-Hub-Signature-256` is verified.
6. Copy the WABA ID into `META_WHATSAPP_BUSINESS_ACCOUNT_ID`, redeploy, and sync templates.

## Local verification

```bash
npm ci
npm run lint
npm test
npm run test:smoke
npm run firestore:indexes:check
```

Common blocks are intentional: `MARKETING_OPT_IN_REQUIRED`, `CUSTOMER_OPTED_OUT`, `TRANSACTION_RECORD_NOT_VERIFIED`, `TEMPLATE_NOT_APPROVED`, `MARKETING_FREQUENCY_LIMIT`, and `DUPLICATE_SEND_BLOCKED` protect the business and explain why Meta was not called.
