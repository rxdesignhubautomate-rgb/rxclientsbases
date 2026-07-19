# Vercel deployment

Vercel runs this Express API as a request-based function. The files `api/index.js`
and `vercel.json` expose every application route through that function.

## Deploy

1. Import the repository into Vercel.
2. Keep the root directory set to the directory containing `package.json` and
   `vercel.json`.
3. Add the required values from `.env.example` under Project Settings >
   Environment Variables.
4. For a new Firebase CRM, set:

   ```text
   ENABLE_LEGACY_DUAL_WRITE=false
   USE_NEW_CRM_READS=true
   WORKERS_ENABLED=false
   LEGACY_JOBS_ENABLED=false
   ```

5. Deploy, then open `/health` and `/ready` on the production domain.

The root URL also returns a small JSON service descriptor, so a Vercel-branded
404 means the repository or Root Directory is still configured incorrectly.

## Background-processing limitation

The inbound, outbound, media, sequence, and digest workers use long-running
polling timers when the service is deployed normally. Vercel Functions do not
provide an always-on process after requests finish. Keep the worker flags off on
Vercel. Deploy the API on an always-on Node host when WhatsApp processing and
retries must run continuously, or move those jobs to a durable queue/worker
platform before relying on Vercel alone.
