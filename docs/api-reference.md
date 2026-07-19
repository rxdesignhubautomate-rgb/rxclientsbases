# API reference

All internal endpoints use `/api/v1`, require `Authorization: Bearer <Firebase ID token>`, return a request ID, and derive `orgId` from the provisioned user. `OWNER` and `ADMIN` bypass permission checks; other roles need the route permission and assignment scope.

List endpoints accept `limit` (1-100), `cursor`, `sortBy`, `sortOrder=asc|desc`, `search`, `status`, `assignedTo`, `from`, and `to` where relevant. Responses use `{ success, data, pagination, meta }`.

## Contacts and identities

```text
POST   /api/v1/contacts
GET    /api/v1/contacts
GET    /api/v1/contacts/:contactId
PATCH  /api/v1/contacts/:contactId
POST   /api/v1/contacts/:contactId/merge
GET    /api/v1/contacts/:contactId/timeline
POST   /api/v1/contacts/:contactId/channel-identities
GET    /api/v1/contacts/:contactId/channel-identities
PATCH  /api/v1/channel-identities/:channelIdentityId
```

Merge body: `{ "duplicateContactId": "CNT_..." }`.

## Channel accounts

```text
GET    /api/v1/channel-accounts
POST   /api/v1/channel-accounts
GET    /api/v1/channel-accounts/:channelAccountId
PATCH  /api/v1/channel-accounts/:channelAccountId
POST   /api/v1/channel-accounts/:channelAccountId/activate
POST   /api/v1/channel-accounts/:channelAccountId/disable
POST   /api/v1/channel-accounts/:channelAccountId/make-default
```

Tokens are rejected/ignored because only public account metadata is persisted.

## Conversations and messages

```text
GET    /api/v1/conversations
GET    /api/v1/conversations/:conversationId
GET    /api/v1/conversations/:conversationId/messages
POST   /api/v1/conversations/:conversationId/messages
POST   /api/v1/conversations/:conversationId/assign
POST   /api/v1/conversations/:conversationId/close
POST   /api/v1/conversations/:conversationId/reopen
POST   /api/v1/conversations/:conversationId/snooze
POST   /api/v1/conversations/:conversationId/human-takeover
POST   /api/v1/conversations/:conversationId/ai-mode
POST   /api/v1/conversations/:conversationId/internal-note
GET    /api/v1/messages/:messageId
POST   /api/v1/messages/:messageId/retry
POST   /api/v1/messages/:messageId/mark-read
```

Use `Idempotency-Key` when sending from a dashboard. A successful send request returns HTTP 202 because delivery is asynchronous.

## Business operations

Leads support create/list/get/patch, assign, change-status, convert, and timeline under `/api/v1/leads`.

Quotations support create/list/get/patch, PDF generation, send, accept, and reject under `/api/v1/quotations`.

Follow-ups support create/list/get/patch, `/due`, complete, and reschedule under `/api/v1/followups`.

Orders support create/list/get/patch, change-status, assign-designer, add-payment, and timeline under `/api/v1/orders`.

## Dashboard, users, attachments, and system

```text
GET  /api/v1/dashboard/summary
GET  /api/v1/dashboard/pipeline
GET  /api/v1/dashboard/followups
GET  /api/v1/dashboard/sales-performance
GET  /api/v1/dashboard/unread-counts
GET  /api/v1/users
POST /api/v1/users
PATCH /api/v1/users/:userId
POST /api/v1/attachments?contactId=...&conversationId=...
GET  /api/v1/attachments/:attachmentId
GET  /api/v1/system/info
GET  /health
GET  /ready
```

Attachment upload sends raw bytes, `Content-Type`, and `X-Filename`; the API returns metadata. Downloads use a 15-minute signed URL.

## Webhooks

Meta verification and delivery use `GET|POST /webhooks/whatsapp`. `/webhook/whatsapp` is a compatibility alias. POST requires `X-Hub-Signature-256` in production.
