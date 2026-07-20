# Security

- Firebase ID tokens are verified with revocation checking. The backend loads the active user record and derives `userId`, `orgId`, role, and permissions.
- `OWNER`/`ADMIN` have elevated access; SALES list/get/update paths are assignment scoped. Processing roles receive only explicitly granted order permissions.
- Direct Firestore and Storage client access is denied by rules. Admin SDK access occurs only on the server.
- Helmet, strict origin CORS, rate limits, 1 MB JSON/20 MB attachment limits, Zod validation, request IDs, and sanitized error envelopes are enabled.
- Meta webhook bodies are HMAC-verified in production. Raw bodies are retained only in `webhookEvents` for processing/audit and redacted from normal logs.
- Pino redacts authorization/cookies/tokens/private keys and webhook entry bodies. Production responses never include stacks.
- Provider access tokens, Firebase private keys, OpenAI keys, and service-account files are never persisted in Firestore or committed.
- Audit logs cover contact changes/merge, conversation state, account switching, messages, quotations/orders/payments, and user permissions.
- AI output is schema-validated and field-allowlisted. OFF and human takeover block generation; ASSIST never sends; AUTO requires both conversation mode and the global auto-send switch, plus safe intent/confidence.

Rotate a leaked secret in its provider, update Render, redeploy, and audit recent webhook/outbox/API activity. Disabling a channel account blocks sends but does not revoke Meta credentials; rotate credentials separately.

## Dependency advisory status

The final `npm audit --omit=dev --audit-level=high` gate passes with no high or critical advisory. npm still reports six moderate transitive findings for `uuid@9` through Firebase Admin's Cloud Storage dependencies. The advisory concerns caller-supplied buffers in UUID v3/v5/v6; this application does not call those APIs. Firebase Admin 14.2.0 is already installed, and npm's proposed force fix is an unsafe downgrade to Firebase Admin 10.3.0, so it was not applied. Recheck on each release and update when Google publishes a compatible dependency chain.
