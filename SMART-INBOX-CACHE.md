# Smart inbox cache API

This backend adds incremental inbox synchronization for the CRM frontend.

## Endpoint

`GET /api/chats/changes?since=<ISO timestamp>` returns only accessible chats whose `lastMessageAt` changed after the supplied watermark. The response includes a server-generated `syncAt` watermark for the next request.

The endpoint uses the existing `assignedTo + lastMessageAt` Firestore composite index already listed in `firestore.indexes.json`; no additional index is required.

If more than 500 chats changed between syncs, `resetRequired` is returned and the frontend rebuilds its complete paginated cache. This avoids silently missing updates after a long offline period.

Deploy this backend before the matching frontend ZIP. The existing full inbox endpoint now also returns `syncAt`, and `/api/chats/config` advertises `features.inboxDelta: true`.
