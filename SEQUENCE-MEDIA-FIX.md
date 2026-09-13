# Visual Aid sequence media repair

The supplied logs show Meta rejecting `video.id` on step 0 for multiple contacts. They do not establish whether the underlying ID expired, was deleted, belongs to a different number/account, or refers to an image rather than a video. Repeated retries cannot make an invalid ID valid.

The `sequence_step_send_failed` log label matches the original scheduler in the supplied backend ZIP. The updated backend in this package must still be deployed to Render; no production settings or customer messages were changed here.

## Immediate recovery

1. Temporarily set `SEQUENCE_SCHEDULER_ENABLED=false` in Render and deploy the setting while replacing the bad media. This pauses scheduled sequence processing; it does not itself disable ordinary chat replies or the separate AI settings.
2. Upload the actual first MP4 video again through the existing admin endpoint `POST /api/leads/sequence/videos/upload/1`, with binary file bytes and `Content-Type: video/mp4`. Use the current backend's configured WhatsApp phone number and token. The returned numeric `id` is the messaging media ID; do not substitute a template upload handle, message ID, local file path or image ID.
3. Verify that the upload saved successfully to Firestore. The existing upload response includes `saveWarning` if saving failed; an upload ID alone does not mean the sequence configuration changed.
4. Update the effective sequence configuration, then review affected contacts before enabling automation again. Do not restart all sequences or replay already-sent steps automatically.

The original sequence uses `settings/sequenceVideos.visual_aid.video1` ahead of `VISUAL_AID_VIDEO_1` / `VISUAL_AID_SEQUENCE_VIDEOS`. The newer backend also supports `settings/chatSequence.steps`, which takes priority over those defaults. Existing enrolled contacts can have a snapshotted `lead.sequencePlan`; changing a default does not overwrite that plan. The effective next step is visible in the contact's Sequence tools.

## Changes in this package

- Numeric media IDs and direct HTTP(S) links are distinguished before sending, including uppercase URL schemes. Invalid handles and file paths fail before contacting Meta.
- The exact Meta HTTP 400 / code 100 invalid video or image ID response is classified as a confirmed rejection. Timeouts, generic Graph errors and failures after acceptance remain uncertain and cannot use the repair path.
- Confirmed invalid media pauses the affected sequence without incrementing its step. A persistent failure record prevents later attempts with the same phone-number/type/media combination across contacts. Concurrent requests already in flight cannot be recalled.
- Sequence upload slots 1–3 accept MP4 files; slot 4 accepts JPEG/PNG images. Content signatures and size limits are checked before upload. Meta still validates full video format/codec support.
- A rejected step can be repaired with a fresh ID verified against the configured phone number and expected media type, while preserving the run, completed steps and later steps. Repairing does not send or resume anything.
- Clicking Pause again preserves a failure reason, so it cannot hide an uncertain delivery or bypass the repair requirement.

## New endpoints after deployment

All requests use the CRM's existing authentication. Keep Meta tokens in backend environment variables, never in browser code or chat messages.

**Read-only media check, admin only**

`POST /api/chats/sequence-media/check`

```json
{"media":"NEW_WHATSAPP_MEDIA_ID","type":"video"}
```

A successful ID check returns `media.verified: true`, the MIME type and size. It queries Meta with `phone_number_id` to verify ownership and does not return the temporary download URL. For a direct URL, it returns `verified: false`; URL access cannot be confirmed by an ID lookup.

**Repair one confirmed rejected step, with lead access checks**

`POST /api/chats/LEAD_ID/sequence`

```json
{"action":"repair_media","media":"NEW_WHATSAPP_MEDIA_ID"}
```

This requires a contact paused by the updated scheduler with reason `invalid_sequence_media` and a delivery recorded as `rejected`. The new ID must be verified for the correct media type and differ from the old ID. Existing failures recorded as uncertain require manual delivery review; they cannot be converted to known rejections.

After verifying the returned plan, use the existing Resume control, or submit `{"action":"resume"}` to the same endpoint. Resume explicitly enables automation and still checks opt-out, blocked/closed contacts and the actual customer reply window. Global `SEQUENCE_SCHEDULER_ENABLED` must also be enabled before the scheduler runs again. If the customer reply window has expired, wait for a new inbound message before resuming the free-form sequence.

These new diagnostic/repair operations are backend APIs. The current frontend does not yet provide a dedicated media-repair button; the ordinary Resume button remains available after a successful repair.

## Verification

38 backend checks passed, including the exact reported Meta error, wrong-type upload prevention, shared failed-media blocking, preserved step progress, fresh-ID verification, permission checks, uncertain sends and errors after acceptance. All Meta requests in tests were mocked. Live IDs, uploads and customer delivery were not tested because production credentials and the actual video were not available in this workspace.

Sources: [Meta: retrieving media with phone-number ownership checks](https://www.postman.com/meta/whatsapp-business-platform/request/fpj02x0/retrieve-media-url), [Meta: media upload and messaging examples](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-209befd3-a956-4d0d-b690-baf220a17600).
