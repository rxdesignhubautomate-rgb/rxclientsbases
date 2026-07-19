# WhatsApp channel switch guide

This procedure preserves contacts, leads, conversations, messages, attachments, and historical account references.

## 1. Add the new account

Add its Meta secrets to Render. Create the account through `POST /api/v1/channel-accounts` (or update environment values and use the seed command for the default ID) with `status=ACTIVE`, `sendEnabled=true`, and `isDefault=false`. Never put its token in the request body or Firestore.

## 2. Validate and activate

Call `POST /api/v1/channel-accounts/:newId/activate`. Confirm the returned phone-number ID and provider metadata. Activation alone does not route sends.

## 3. Make it default

Call `POST /api/v1/channel-accounts/:newId/make-default`. The transaction verifies the account is active/send-enabled and clears the prior default for the same organization/channel.

Existing conversations may still display the historical current account until the next send. Message creation resolves the requested account; if it is disabled, it selects the active default and records that new account on the new message.

## 4. Disable the old account

Call `POST /api/v1/channel-accounts/:oldId/disable`. This sets status disabled, turns send/receive flags off, and clears default. It does not rewrite any message, conversation history, lead, or contact.

## 5. Verify routing

Send a controlled message through `POST /api/v1/conversations/:conversationId/messages` with an idempotency key. Confirm:

- the new message has `channelAccountId=:newId`;
- its outbox has the same account ID;
- the worker sets a provider message ID and `SENT`;
- a status webhook advances it to delivered/read;
- older messages still show `:oldId`;
- the contact and lead IDs did not change.

If verification fails, disable sending on the new account, correct secrets/metadata, and retry the failed message. Do not re-enable the banned number merely to preserve history; history is independent of provider availability.
