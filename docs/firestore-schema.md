# Firestore schema

All new business records have `orgId=RXDH`, permanent IDs, `createdAt`, and normally `updatedAt`. Canonical timestamps are Firestore timestamps/JavaScript dates; business `date` and `time` fields are rendered in Asia/Kolkata.

## Business collections

- `organizations`: organization profile and defaults.
- `users`: Firebase UID mapping, role, active flag, and explicit permissions.
- `contacts`: permanent customers; phone is never the document ID.
- `channelIdentities`: external WhatsApp/email/site identities linked to contacts.
- `channelAccounts`: non-secret provider account metadata and routing state.
- `leads`: legacy phone-ID documents plus new `LEAD_<ULID>` documents. New queries require `orgId`.
- `conversations`: open/pending/snoozed/closed channel context, assignment, AI mode, summary, and unread state.
- `messages`: legacy auto-ID documents plus new `MSG_<ULID>` append-focused documents. Messages are never embedded in a conversation.
- `attachments`: organization/contact-scoped Cloud Storage metadata and hashes.
- `quotations`, `quotationItems`, `followUps`, `orders`, `orderItems`, `payments`: linked business operations.

## Reliability and operations collections

- `webhookEvents`: raw payload, hash, status, attempts, locks, and processing timestamps.
- `outbox`: durable sends and atomic worker locks.
- `deadLetters`: original failed record, sanitized error, attempts, and manual-retry status.
- `notifications`: team-visible operational and AI handoff notices.
- `auditLogs`: append-only sensitive change history.
- `automationJobs`, `systemSettings`: automation and configuration records.
- `idempotencyKeys`, `providerMessageKeys`: webhook, migration, inbound-message, AI-draft, and outbound deduplication.
- `channelIdentityKeys`, `contactPhoneKeys`, `openConversationKeys`, `activeLeadKeys`: atomic uniqueness/routing pointers.

## IDs

`CNT`, `LEAD`, `CONV`, `MSG`, `QUO`, `ORD`, `ATT`, `WHE`, `OUT`, `AUD`, `USR`, and related item prefixes use sortable ULIDs. Existing legacy IDs are preserved in `legacyIds` and are never rewritten destructively.

## Indexes

`firestore.indexes.json` covers implemented queries for organization/status/assignment contacts, conversations, messages, leads, follow-ups, orders, webhook work, outbox work, identities, and channel accounts. Deploy indexes before cutover. Firestore may request an additional index if a future dashboard combines filters not implemented today; add only the query-specific index named by Firestore.
