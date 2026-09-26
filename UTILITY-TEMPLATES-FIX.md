# Approved Utility template discovery fix

Backend version: `2.18.0-dev.4`

## What changed

- The WhatsApp composer now receives all templates that Meta reports as both `UTILITY` and `APPROVED`.
- Existing configured templates keep their familiar labels and behaviour.
- Newly added Meta Utility templates no longer need a hard-coded backend allowlist entry.
- Marketing, pending, rejected and paused templates remain excluded.
- Dynamic templates support positional and named body variables, text-header variables, and image/video/document headers.
- A dynamic Utility send still requires a linked CRM order and passes through the existing transaction, approval, idempotency and outbox safety checks.

## Deployment

1. Deploy this backend folder to the existing Render service.
2. Keep the current environment variables and secrets unchanged.
3. Wait for the deployment to become `Live`.
4. In the CRM, open **WhatsApp → Approved template → Sync Meta templates**.
5. Reopen the template dropdown. Newly added Meta templates with status `APPROVED` and category `UTILITY` will appear.

No Firebase migration, frontend deployment or contact upload is required for this fix.

## Verification completed

- Backend: 243 tests passed.
- Frontend compatibility: 49 tests passed.
- Frontend build passed.
- Modified backend files passed ESLint and Node syntax checks.
