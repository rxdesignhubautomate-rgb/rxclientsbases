# Troubleshooting

## `/ready` returns 503

Check the Firebase project/client email/private key, escaped newlines, storage bucket, IAM access, and Firestore availability. `/health` can remain green while a dependency is unavailable.

## Meta verification fails

Confirm callback path `/webhooks/whatsapp`, verify token equality, public HTTPS, and no trailing-space secret. GET verification does not use the app secret; POST delivery does.

## POST webhook returns 401

Set the correct `META_APP_SECRET`. Do not use the verify token as the app secret. Ensure proxies preserve `X-Hub-Signature-256`; the service verifies the original JSON bytes captured by Express.

## Event remains PENDING/RETRY

Check `WORKERS_ENABLED`, structured logs by `webhookEventId`, `attemptCount`, and `lastError`. After the configured maximum, inspect the linked dead letter and notification. Correct the dependency/account issue, then replay through an explicit admin workflow rather than editing provider IDs.

## Outbox is RETRY/FAILED

Check account `status`, `sendEnabled`, default routing, recipient identity, Meta token/permissions, and template approval. A disabled account is a permanent failure. Use the message retry endpoint after correction; it writes an audit log and a new outbox record.

## Firestore requests an index

Deploy `firestore.indexes.json`. If a new filter combination is intentionally added, add the exact index requested by Firestore and document the query; avoid speculative indexes.

## AI creates no reply

Check conversation `aiMode`, `humanTakeover`, `OPENAI_API_KEY`, and global `AI_AUTO_SEND_ENABLED`. ASSIST intentionally creates an internal draft. Unsafe AUTO intents intentionally create a draft and notification.

## Migration has duplicates

Stop the batch, leave legacy records intact, inspect `duplicateMatches` and contact review notifications, merge only after manual confirmation, then rerun the same bounded batch. Idempotency makes reruns safe.
