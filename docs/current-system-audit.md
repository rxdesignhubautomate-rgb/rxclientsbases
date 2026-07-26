# Current system audit

Audit date: 2026-07-20. Source inspected: the most recent locally available `rx-whatsapp-crm` working copy. No repository archive was attached to the request, so the source copy is preserved unchanged in its earlier Codex workspace and this migration is performed on a new copy.

## Existing architecture

- Node.js 20, Express 4, ES modules, Firebase Admin/Firestore, OpenAI Chat Completions, and the Meta WhatsApp Cloud API.
- `server.js` owns process startup, `/health`, Meta webhook verification/receipt, legacy dashboard routes, error handling, and two in-process schedulers.
- `services/leadProcessor.js` receives normalized text messages, checks duplicate provider IDs, creates/loads a lead, stores the inbound message, invokes rules or OpenAI, sends the reply, and stores the reply.
- `services/leadStore.js` owns the legacy `leads`, `messages`, `salesUsers`, and `settings` collections. A lead document ID is the WhatsApp phone number.
- `services/whatsapp.js` contains Meta normalization and direct send/upload calls. Text, image, video, and template messages are sent directly by routes and schedulers.
- AI prompting is implemented in `services/aiAgent.js` with business knowledge in `services/knowledgeBase.js`. It already avoids budgets and fixed prices and includes a local fallback.
- Dashboard authentication is a shared API key or device-code approval. It is not Firebase Authentication and does not enforce organization boundaries.
- Existing dashboard endpoints are `/api/leads` and `/api/devices`; the webhook is `/webhook/whatsapp`.
- Existing background jobs provide visual-aid sequences, hot-lead alerts, and daily digests.
- There were no automated tests, lint configuration, Firestore index file, security rules, migration scripts, readiness check, structured logger, request IDs, or durable worker records.

## Existing environment and deployment assumptions

The existing code reads `PORT`, OpenAI, Meta/WhatsApp, Firebase service-account, dashboard/device, sales-team, scheduler, sequence-video, alert, and digest variables. It binds to `PORT` and is compatible with a Render web service, but startup previously required every Meta/OpenAI secret even for non-webhook maintenance commands.

## Important risks

1. Phone-number document IDs make channel switching, identity merging, and multi-channel contacts unsafe.
2. Query-then-write webhook deduplication can race and create duplicate messages or replies.
3. Direct provider sends have no durable outbox, atomic claim, retry schedule, dead letter, or replay audit.
4. The webhook returns quickly, but its work only lives in process memory; a restart after the response can lose processing.
5. Media remains provider-hosted or provider-uploaded and is not archived to organization-scoped storage.
6. ISO-string timestamps and unscoped collections make multi-organization queries and authorization fragile.
7. Shared keys and trusted device headers are insufficient for production identity and role authorization.
8. Full internal error details were returned to clients and logs were unstructured.
9. In-process schedulers can duplicate work when Render runs multiple instances.

## Backward-compatible migration plan

- Keep every legacy collection and source module. Add new permanent-ID collections alongside them.
- Keep legacy dashboard paths while introducing Firebase-authenticated `/api/v1` APIs.
- Accept both `/webhook/whatsapp` and `/webhooks/whatsapp`, but persist a durable, idempotent event before returning.
- Use `ENABLE_LEGACY_DUAL_WRITE=true` during backfill and validation. Never delete or rename legacy data automatically.
- Route every new and legacy business send through the outbox and a channel adapter. Historical messages keep their original `channelAccountId`.
- Use `USE_NEW_CRM_READS` only after migration verification passes.
- Run migration commands in `--dry-run` mode first and archive legacy data only after an explicit operational decision.

## Files intentionally preserved

The root `config.js`, `firebase.js`, `middleware/`, `routes/`, `services/`, `utils/`, `SALES_ENGINE_SETUP.md`, and legacy data contracts remain available. New production code lives under `src/`; compatibility changes to legacy send points are limited to queueing through the new outbox.

## Recommended checkpoint

Commit or archive the unmodified source before deploying version 2. The earlier source remains untouched; this working directory is the migration branch/copy.
