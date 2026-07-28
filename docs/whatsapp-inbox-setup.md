# WhatsApp Inbox setup

The CRM WhatsApp Inbox uses the official Meta Cloud API. It shows chats beside the client's existing orders, records delivery/read states, lets staff update order status, and restricts outbound messaging to policy-safe modes:

- Free-form replies are allowed only while the 24-hour customer-service window is open.
- When the window is closed, the API accepts only a whitelisted, approved Utility template.
- Changing an order status never sends a customer message automatically. Staff must review and send the prepared update.

Meta pricing and classification rules can change. Confirm current rates at <https://business.whatsapp.com/products/platform-pricing>.

## 1. Create the templates in Meta

Open **WhatsApp Manager → Account tools → Message templates → Create template**. Choose category **Utility** and language **English**. Create these exact lowercase names and bodies. Do not add a header, footer, button, offer, discount, or product recommendation.

### `rx_order_confirmation`

```text
Hello {{1}}, your order {{2}} has been confirmed. Order value: {{3}}.
```

Sample variables: `Rahul`, `ORD-1025`, `INR 12,500`.

### `rx_design_approved`

```text
Hello {{1}}, the design for order {{2}} has been approved. Production will now proceed as approved.
```

Sample variables: `Rahul`, `ORD-1025`.

### `rx_ready_to_dispatch`

```text
Hello {{1}}, your order {{2}} is ready to dispatch. Dispatch details will be shared after handover.
```

Sample variables: `Rahul`, `ORD-1025`.

### `rx_experience_feedback`

```text
Hello {{1}}, order {{2}} has been completed. Please reply and share your experience with this order.
```

Sample variables: `Rahul`, `ORD-1025`.

Submit each template and wait until its status becomes **Approved**. If Meta changes the category to Marketing or rejects it, do not work around the decision: remove promotional wording and resubmit as a new Utility template.

Cross-selling is not included in `rx_experience_feedback`. Create it separately as a **Marketing** template and send it only to contacts with recorded marketing opt-in. Combining feedback and a sales recommendation makes the message promotional.

After all four show **Approved**, deploy the backend and run the CRM's authenticated template sync:

```text
POST /api/v1/whatsapp/templates/sync
```

The CRM will show only these four Utility choices. It will still block sending if Meta reports `NOT_SYNCED`, `PENDING`, `PAUSED`, `REJECTED`, or any status other than `APPROVED`.

## 2. Deploy the Firestore indexes

The inbox uses IndexedDB plus delta queries, so an active browser checks every five seconds without rereading the full chat history. Polling pauses while the tab is hidden. Deploy the included `firestore.indexes.json` to the `clientdatabase-10e9b` Firebase project:

```bash
firebase use clientdatabase-10e9b
firebase deploy --only firestore:indexes
```

## 3. Deploy the backend

Deploy this backend version to Render. Keep the existing Meta and Firebase variables. Outbound messages need the worker process:

```env
WORKERS_ENABLED=true
LEGACY_JOBS_ENABLED=false
OUTBOX_POLL_INTERVAL_MS=15000
INBOUND_POLL_INTERVAL_MS=15000
MEDIA_POLL_INTERVAL_MS=60000
```

The worker intervals and quota backoff are intentionally conservative. Do not reduce them unless Firestore usage has been measured.

## 4. Deploy the frontend

Build and deploy frontend v1.2 or newer to Vercel. Sign out and sign in once after deployment so existing Sales sessions receive the current attachment permissions.

## 5. Use it

1. Open **Clients** and choose a client.
2. Click **Open WhatsApp**. Imported clients with a valid phone number receive a WhatsApp identity automatically.
3. If the client has not messaged within 24 hours, select an approved Utility template.
4. Select the related order and review every template value.
5. Send the update. The inbox will show queued, sent, delivered, and read states from Meta webhooks.

Always obtain and retain the customer's WhatsApp opt-in before business-initiated messaging.

## Inbox features in v2.1

Inside an open 24-hour customer-service window, agents can use:

- text and URL previews;
- image, video, audio/voice-note, and document attachments up to the API upload limit;
- quoted replies and reactions;
- current location, contact cards, and up to three interactive quick-reply buttons;
- built-in/custom quick replies and private internal notes.

The client workspace beside the chat supports Important status, tags, private notes, owner assignment, follow-up scheduling, order status review, and a direct phone link. Messages are durable: the API stores them in Firestore, files in Cloud Storage, and delivery/read updates from the Meta webhook.

Desktop alerts require the user to press **Enable alerts** once and allow notifications in the browser. Microphone and location sharing also require browser permission.

## Features that still require Meta-side setup

The release exposes readiness information at:

```text
GET /api/v1/whatsapp/capabilities
```

The following cannot be activated by deploying CRM code alone:

- **Business App coexistence:** complete Meta Embedded Signup/coexistence onboarding for the eligible business number.
- **WhatsApp calling:** enable it in WhatsApp Manager only if the business, number, country, and API account are eligible; add call webhooks and call controls in a later account-specific integration.
- **Flows:** create, publish, and connect each Flow in Meta before sending it from an interactive message.
- **Catalog, carts, orders, and payments:** link a Commerce Manager catalog and use only the commerce/payment products available for the account and market.

Groups, broadcast lists, Channels/Status, disappearing messages, and consumer-app backup/restore are not Cloud API CRM features. Do not build business operations around them.

## Daily safety rules

- Outside 24 hours, use an approved template with its real Meta category.
- Do not disguise promotions as Utility messages.
- Record marketing opt-in and honor STOP/opt-out immediately.
- Keep `WORKERS_ENABLED=true`; the outbox sends messages and retries transient Meta errors.
- Leave the conservative polling intervals in place until Firestore and Render usage has been measured.
- If attachments fail for an already signed-in Sales user, sign out and back in before investigating further.
