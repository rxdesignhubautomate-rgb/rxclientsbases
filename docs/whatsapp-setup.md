# WhatsApp Cloud API setup

1. Create/select a Meta app with WhatsApp Cloud API and add the RX Design Hub business/phone number.
2. Set `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_APP_SECRET`, and a private random `META_VERIFY_TOKEN` in Render.
3. Deploy the service and confirm `/health` and `/ready` return 200.
4. Set the callback URL to `https://YOUR_HOST/webhooks/whatsapp` and enter the same verify token.
5. Subscribe to the messages field so inbound messages and sent/delivered/read/failed status updates arrive.
6. Seed non-secret account metadata:

```bash
npm run seed:channel -- --dry-run --org-id=RXDH
npm run seed:channel -- --org-id=RXDH
```

7. Send an inbound test and verify one each of `webhookEvents`, contact/identity, active lead, open conversation, and inbound message.
8. Send from the authenticated messages endpoint and verify `message -> outbox -> SENT -> providerMessageId`.

POST requests are verified with the raw-body HMAC signature. The webhook acknowledges only after the durable event/idempotency transaction; OpenAI and media work occurs in the worker.

Access tokens remain environment secrets. `channelAccounts` contains only identifiers and operational flags. For future account-specific tokens, use account-specific secret-manager/environment lookup; do not add token fields to Firestore.
