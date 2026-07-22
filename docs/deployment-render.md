# Render deployment

## Web service

- Runtime: Node
- Node version: 22
- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/health`
- Auto-deploy: keep off for the first migration/cutover
- Persistent disk: not required; Firestore and Cloud Storage hold durable data

Create secret environment values from `.env.example`. Do not commit service-account JSON. Keep `AI_DEFAULT_MODE=ASSIST` and `AI_AUTO_SEND_ENABLED=false` until human review and monitoring are complete.

Render must expose `PORT`; the server binds to it. The process handles SIGTERM, stops worker polling, and closes the HTTP listener. `/health` does not call dependencies; `/ready` verifies Firestore.

## Worker model

The starter deployment runs Firestore-backed inbound and outbound pollers inside the web service. Atomic locks make multiple instances safe. If traffic grows, create dedicated worker services using separate worker entry points/a deployment split and turn the equivalent web-process workers off; do not run non-transactional schedulers on multiple replicas.

## Release order

1. Deploy rules/indexes.
2. Deploy with dual-write on and new reads off.
3. Seed the channel account and owner.
4. Verify health/readiness, webhook signature, inbound persistence, and outbox delivery.
5. Run dry-run then bounded migrations.
6. Switch reads only after verification.

`render.yaml` contains non-secret defaults. Render dashboard secrets override them.
