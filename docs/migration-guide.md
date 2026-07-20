# Migration guide

## Preconditions

Back up/export Firestore, deploy indexes, create the default channel account, keep `ENABLE_LEGACY_DUAL_WRITE=true`, and keep `USE_NEW_CRM_READS=false`. Do not delete legacy documents.

## Phase 1: audit and dry run

```bash
npm run migrate:audit -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:backfill-contacts -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:backfill-conversations -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:backfill-messages -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:verify -- --dry-run --limit=100 --org-id=RXDH
```

Review `scanned`, `migrated`, `skipped`, `failed`, `duplicateMatches`, duration, and sanitized failures in `migration-reports/`.

## Phase 2: bounded writes

Run each stage without `--dry-run`, in order. Start with a small limit. Continue with the last source document ID printed/observed as `--start-after=<document-id>`.

```bash
npm run migrate:backfill-contacts -- --limit=25 --org-id=RXDH
npm run migrate:backfill-conversations -- --limit=25 --org-id=RXDH
npm run migrate:backfill-messages -- --limit=100 --org-id=RXDH
npm run migrate:verify -- --limit=500 --org-id=RXDH
```

Rerunning a batch is safe: contact/conversation routing keys and migration idempotency records cause migrated documents to be skipped.

## Phase 3: dual-write verification

Compare contact, lead, conversation, message, account, and provider IDs for new inbound traffic. Test webhook retry, media, ASSIST drafts, human takeover, outbox retries, and delivery statuses.

## Phase 4: cutover

Set `USE_NEW_CRM_READS=true`, redeploy, and observe for at least one operating cycle. Then set `ENABLE_LEGACY_DUAL_WRITE=false`. Neither flag deletes legacy data.

## Rollback and recovery

Restore the prior flags and redeploy. New permanent-ID documents may remain; idempotency prevents duplicates on a later retry. Never use a bulk delete as rollback. Archive legacy exports only after business sign-off and a tested restore.
