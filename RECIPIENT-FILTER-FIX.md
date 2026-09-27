# Recipient safety filter

Version `2.18.0-dev.5` adds server-side recipient filtering to both legacy campaign batches and verified order Utility batches.

Automatically excluded:

- messages already accepted, sent, delivered or read;
- messages currently queued or sending;
- messages with an uncertain provider submission/delivery result;
- suppressed, blocked or opted-out contacts;
- duplicate phone numbers within the newly prepared batch.

Confirmed `FAILED` messages remain eligible for a controlled retry. Campaign recipients are checked when batches are created and checked again immediately before a campaign starts. Utility history is scoped to the same order and Utility template, so a valid update for a different order is not accidentally blocked.

The API responses include `excludedContacts` / `exclusionCounts` for campaign preparation and `exclusionCounts` for Utility batch submissions. The history scans use only the organization single-field index and are bounded to 100,000 records.
