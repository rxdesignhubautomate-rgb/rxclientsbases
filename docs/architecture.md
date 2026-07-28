# Architecture

## System boundary

The CRM owns contacts, identities, conversations, messages, attachments, leads, quotations, follow-ups, orders, payments, audit records, and delivery state. A phone number is an attribute and channel identity—not a customer document ID. Every business document includes `orgId`; authenticated requests take it from the provisioned user rather than request input.

## Inbound data flow

```text
Customer channel
  -> signed webhook
  -> webhookEvents + idempotencyKeys transaction
  -> immediate HTTP 200
  -> inbound worker atomic claim
  -> channel adapter normalization
  -> contact + channel identity resolution
  -> active lead + open conversation
  -> append-focused message transaction
  -> permanent media archive
  -> optional legacy dual-write
  -> AI OFF / ASSIST draft / safe AUTO queue
  -> event PROCESSED
```

The raw provider payload is durably stored before acknowledgment. Event keys prevent identical webhook records; provider-message keys prevent duplicate messages; AI draft/outbound keys prevent duplicate replies. The webhook HTTP request never waits for OpenAI or media download.

## Outbound data flow

```text
Dashboard / AI / legacy scheduler
  -> message service
  -> message + outbox transaction
  -> outbound worker atomic claim
  -> channel manager
  -> provider adapter
  -> provider message ID saved
  -> delivery webhook updates SENT / DELIVERED / READ / FAILED
```

Temporary failures use configured backoff. Permanent or exhausted failures update the message and outbox, create a `deadLetters` record, and notify admins. A disabled account fails closed; message history is not rewritten.

## Identity and deduplication

- `CNT_<ULID>` is the permanent contact ID.
- `channelIdentityKeys` provides an atomic key for `(orgId, channel, externalUserId)`.
- `contactPhoneKeys` provides an atomic key for normalized phone numbers.
- Multiple legacy matches create a review notification instead of an automatic destructive merge.
- Contact merge re-links identities and business documents, updates routing keys, preserves both contact documents, and writes an audit log.

## Process model

Render runs the API and short polling workers in one Node process by default. Firestore transactions make claims safe across multiple instances. For larger load, run the same worker classes in dedicated Render worker services and disable the corresponding web-process poller.

## Compatibility

Legacy `/api/leads`, `/api/devices`, sequence, alert, and digest code remains present. Its send functions now queue through the new outbox. Legacy and permanent-ID records coexist in `leads` and `messages`; new reads always filter by `orgId` and permanent IDs.
