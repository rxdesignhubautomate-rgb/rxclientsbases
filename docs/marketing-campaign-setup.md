# WhatsApp Marketing Campaign setup

This module creates consent-first drip campaigns for interested customers. It uses the existing WhatsApp Cloud API outbox and adds three automatic safety rules:

- only contacts with a recorded WhatsApp Marketing opt-in are enrolled;
- any customer reply pauses that customer's remaining drip steps, and `STOP` records an opt-out;
- creating an order for the customer marks their active enrollment converted and stops future steps.

## 1. Create the exact Meta Marketing template

Open **WhatsApp Manager -> Account tools -> Message templates -> Create template**.

- Category: **Marketing**
- Language: **English (`en`)**
- Name: **`1_marketing`**
- Header: **Video**
- Body:

```text
Hello {{1}} 👋

Doctors ke saamne apne pharma brands ko professionally present kijiye with premium Visual Aid Designing & Printing by RX Design Hub.

✅ Scientific content support
✅ Premium doctor-engaging design
✅ Gloss, Matte, Velvet & UV finishing
✅ PAN-India delivery

Sirf Brand Name aur Composition share kijiye—baaki designing aur visual development hamari team karegi.

Kya aap latest samples aur pricing dekhna chahenge?

Reply STOP TO STOP RECEIVING FROM US
```

The only body variable is `{{1}}`, the customer name. Configure the static website,
phone and STOP buttons in Meta. The CRM does not send separate button parameters.
When creating a campaign, upload the video file used by the approved template; the
backend uploads it to Meta and builds the required video header component.

Wait until Meta shows the template as **Approved**. Keep the name, language and body exactly aligned with the CRM. This is a Marketing template; do not create it as Utility.

## 2. Deploy the Firestore indexes

Deploy the included `firestore.indexes.json` to `clientdatabase-10e9b`:

```bash
firebase use clientdatabase-10e9b
firebase deploy --only firestore:indexes
```

The included indexes improve performance as campaign volume grows. The current index-safe build uses Firestore's automatic single-field indexes for page loading and scheduling, so a missing composite index no longer makes the Marketing page return HTTP 500. Deploy the included indexes before large campaigns and wait until Firebase shows them as **Enabled**.

## 3. Deploy the backend to Render

Keep all existing Firebase and Meta variables, then add or verify:

```env
WORKERS_ENABLED=true
CAMPAIGN_POLL_INTERVAL_MS=60000
CAMPAIGN_BATCH_SIZE=100
OUTBOX_POLL_INTERVAL_MS=15000
```

`60000` means the campaign scheduler checks once per minute and claims at most 100 due enrollments per tick. Audience creation still limits every campaign list to 500 contacts. The existing outbox attempts delivery every 15 seconds, so a 500-contact batch is drained gradually instead of creating a single synchronous API burst.

For media drips, choose `OPEN_WINDOW_ONLY`. The campaign may contain image, video, audio, or document steps, but those steps are queued only while the customer's genuine 24-hour service window is open. Closed enrollments move to `WAITING_FOR_WINDOW`; a new inbound reply activates the next due step. Use `CUSTOMER_REPLY` when the first step must wait for a new reply as well.

Deploy the backend and confirm `/health` is ready before deploying the frontend.

## 4. Deploy the frontend to Vercel

Deploy the matching frontend build. Marketing is visible only to Owner/Admin accounts.

## 5. Use the module

1. Open **Marketing**.
2. Choose the true consent source and use **Record opt-in** only for customers who actually agreed to receive this type of message.
3. Select interested customers and save a list.
4. Choose the list, select `1_marketing`, upload its approved video, add the required steps, select the start time, confirm consent and schedule.
5. Monitor sent, replied, skipped and order counters.
6. Handle replies in **WhatsApp Inbox**. The customer's remaining drip is already paused.
7. Create their order in the CRM; the campaign is attributed and marked converted automatically.

Selecting a customer for a list does not create consent. Contacts with missing consent, an opt-out, no phone number, or an inactive status are skipped at launch.

For a one-time send to every eligible existing client, Owner/Admin can use **One-click existing client send**. Select `1_marketing`, upload the approved video once, keep batches at 500, choose the gap between batches, confirm the recorded-opt-in rule, and schedule. The backend creates and approves the batches automatically. Customers without existing opt-in are excluded rather than silently opted in.

## Operating rules

- Retain evidence of opt-in and record the source accurately.
- Make the expected message category/frequency clear when collecting consent.
- Honour opt-out requests immediately; the CRM recognizes `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, and `QUIT`.
- Do not upload purchased lists or send unrelated promotions to existing-client numbers merely because they previously ordered.
- Review current WhatsApp policy and local legal requirements before every major campaign.
