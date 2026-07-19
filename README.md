# RX Design Hub Communication CRM

Production-oriented, channel-independent CRM and business-operations backend for RX Design Hub. Firebase is the durable business memory, the API is the control centre, WhatsApp is a replaceable adapter, AI is a constrained assistant, and web/Android clients use Firebase Authentication to access versioned APIs.

The migration is non-destructive. Existing `leads`, `messages`, device approvals, sequences, alerts, digest settings, and legacy dashboard endpoints are preserved while permanent IDs and organization-scoped records are added alongside legacy documents.

## Requirements

- Node.js 22 (the current Firebase Admin security release requires Node 22+)
- A Firebase project with Firestore, Firebase Authentication, and Cloud Storage enabled
- A Meta WhatsApp Cloud API application and phone number
- An OpenAI API key when AI mode is not `OFF`

## Local setup

```bash
cp .env.example .env
npm install
npm run seed:channel -- --dry-run --org-id=RXDH
npm run seed:channel -- --org-id=RXDH
npm run seed:admin -- --email=owner@example.com --password=replace-me --name="Owner"
npm run dev
```

On PowerShell use `Copy-Item .env.example .env`. Store real secrets only in `.env` locally and in Render secret environment variables in production. Escaped `\\n` characters in `FIREBASE_PRIVATE_KEY` are converted at startup.

## Important environment variables

The complete list and defaults are in `.env.example`. Production requires Firebase project/client/private-key/storage values; Meta app secret, verify token, access token, and phone-number ID; allowed origins; and an OpenAI key unless `AI_DEFAULT_MODE=OFF`.

Operational switches:

- `ENABLE_LEGACY_DUAL_WRITE=true`: preserve legacy inbound records during migration.
- `USE_NEW_CRM_READS=false`: keep the existing dashboard read path during verification.
- `AI_DEFAULT_MODE=ASSIST`: drafts only by default.
- `AI_AUTO_SEND_ENABLED=false`: disables automatic AI sending globally even for `AUTO` conversations.
- `WORKERS_ENABLED=true`: runs durable inbound and outbound pollers in the web process.

## Run and verify

```bash
npm run lint
npm test
npm run test:smoke
npm start
```

`GET /health` is a lightweight process check. `GET /ready` performs a Firestore read and returns HTTP 503 until the service can use Firebase.

## Safe migration

Always begin with dry runs:

```bash
npm run migrate:audit -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:backfill-contacts -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:backfill-conversations -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:backfill-messages -- --dry-run --limit=100 --org-id=RXDH
npm run migrate:verify -- --dry-run --limit=100 --org-id=RXDH
```

After reviewing the reports in `migration-reports/`, remove `--dry-run` one stage at a time. All backfills support `--limit`, `--start-after`, and `--org-id`, preserve legacy IDs, and skip previously migrated records. Reports contain counts and sanitized source IDs/errors; the directory contents are ignored by Git.

See [migration guide](docs/migration-guide.md) before changing feature flags.

## WhatsApp setup and account recovery

Configure Meta to verify and deliver events to:

```text
https://YOUR_RENDER_HOST/webhooks/whatsapp
```

The legacy `/webhook/whatsapp` form remains accepted. Subscribe to messages and message-status events, and configure `META_APP_SECRET` so POST signatures can be verified.

To replace a banned or unavailable account:

1. Create/seed the new account without changing the old records.
2. Activate the new account.
3. Make it default.
4. Disable the old account.
5. Send a test through `POST /api/v1/conversations/:id/messages` and inspect its message/outbox/account IDs.

Historical messages retain their original `channelAccountId`. See the [channel switch guide](docs/channel-switch-guide.md).

## Firebase configuration

Deploy indexes and the server-owned security rules using the Firebase CLI:

```bash
firebase deploy --only firestore:indexes,firestore:rules,storage
```

Direct client reads and writes are denied. Authenticated clients call the API; Firebase Admin performs database and storage operations.

## Render deployment

Create a Node web service using `npm ci` and `npm start`, add secret environment values, use Node 20, and set `/health` as the health check. `render.yaml` contains safe non-secret defaults. Full instructions are in [deployment-render.md](docs/deployment-render.md).

## Vercel deployment

`api/index.js` and `vercel.json` expose the Express API as a Vercel Function. Set
the Vercel Root Directory to the folder containing `package.json`, add the secret
environment variables, deploy, and verify `/health` and `/ready`. Set
`WORKERS_ENABLED=false` and `LEGACY_JOBS_ENABLED=false` because Vercel does not
provide an always-on process for the polling workers. See
[deployment-vercel.md](docs/deployment-vercel.md) for the deployment steps and
background-processing limitation.

## API and operations documentation

- [Architecture](docs/architecture.md)
- [Current-system audit](docs/current-system-audit.md)
- [API reference](docs/api-reference.md)
- [Firestore schema](docs/firestore-schema.md)
- [WhatsApp setup](docs/whatsapp-setup.md)
- [Migration guide](docs/migration-guide.md)
- [Render deployment](docs/deployment-render.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Channel switching](docs/channel-switch-guide.md)

Existing sales-engine behavior is described in `SALES_ENGINE_SETUP.md`.
