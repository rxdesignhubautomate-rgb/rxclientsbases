# WhatsApp Marketing Campaign setup

This module creates consent-first drip campaigns for interested customers. It uses the existing WhatsApp Cloud API outbox and adds three automatic safety rules:

- only contacts with a recorded WhatsApp Marketing opt-in are enrolled;
- any customer reply pauses that customer's remaining drip steps, and `STOP` records an opt-out;
- creating an order for the customer marks their active enrollment converted and stops future steps.

## 1. Create the exact Meta Marketing template

Open **WhatsApp Manager -> Account tools -> Message templates -> Create template**.

- Category: **Marketing**
- Language: **English (`en`)**
- Name: **`rx_interest_followup`**
- Body:

```text
Hello {{1}}, you previously showed interest in {{2}}. {{3}} If you would like details or help placing an order, reply to this message. Reply STOP to opt out.
```

The variables are:

1. customer name;
2. the interest label entered in the campaign builder;
3. the campaign step line.

Wait until Meta shows the template as **Approved**. Keep the name, language and body exactly aligned with the CRM. This is a Marketing template; do not create it as Utility.

## 2. Deploy the Firestore indexes

Deploy the included `firestore.indexes.json` to `clientdatabase-10e9b`:

```bash
firebase use clientdatabase-10e9b
firebase deploy --only firestore:indexes
```

New indexes cover `marketingAudiences`, `marketingCampaigns` and `campaignEnrollments`. Wait until the Firebase console shows every index as **Enabled** before launching a campaign.

## 3. Deploy the backend to Render

Keep all existing Firebase and Meta variables, then add or verify:

```env
WORKERS_ENABLED=true
CAMPAIGN_POLL_INTERVAL_MS=300000
CAMPAIGN_BATCH_SIZE=20
OUTBOX_POLL_INTERVAL_MS=15000
```

`300000` means the campaign scheduler checks every five minutes. This keeps idle Firestore reads low while preserving practical campaign timing. The existing outbox still attempts delivery every 15 seconds after a campaign message is queued.

Deploy the backend and confirm `/health` is ready before deploying the frontend.

## 4. Deploy the frontend to Vercel

Deploy the matching frontend build. Marketing is visible only to Owner/Admin accounts.

## 5. Use the module

1. Open **Marketing**.
2. Choose the true consent source and use **Record opt-in** only for customers who actually agreed to receive this type of message.
3. Select interested customers and save a list.
4. Choose the list, add one to three drip steps, select the start time, confirm consent and schedule.
5. Monitor sent, replied, skipped and order counters.
6. Handle replies in **WhatsApp Inbox**. The customer's remaining drip is already paused.
7. Create their order in the CRM; the campaign is attributed and marked converted automatically.

Selecting a customer for a list does not create consent. Contacts with missing consent, an opt-out, no phone number, or an inactive status are skipped at launch.

## Operating rules

- Retain evidence of opt-in and record the source accurately.
- Make the expected message category/frequency clear when collecting consent.
- Honour opt-out requests immediately; the CRM recognizes `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, and `QUIT`.
- Do not upload purchased lists or send unrelated promotions to existing-client numbers merely because they previously ordered.
- Review current WhatsApp policy and local legal requirements before every major campaign.
