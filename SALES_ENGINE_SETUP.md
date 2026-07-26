# Sales Engine Upgrade — Setup Guide

New beast-mode features added on top of the existing CRM. Nothing in the old flow changed.

## What's new

1. **Hot Lead Instant Alerts** — the moment a lead turns hot (or asks for quotation/sample/call), a WhatsApp alert goes to the assigned salesperson's phone with name, city, requirement, score, summary, last message, and a one-tap `wa.me` reply link.
2. **Buying-Signal Backstop** — even if the AI misses it, messages like "kitne ka padega", "rate", "urgent", "aaj hi chahiye", "call karo", "500 pcs" force the lead to hot + handoff. Deterministic, no AI needed.
3. **Lead Score 0–100** — stored on every lead (`leadScore`). Temperature + requirement + quantity + urgency + buying signals.
4. **Morning Rep Digest (9:30 IST)** — each rep gets a WhatsApp message: overdue follow-ups, due today, hot open leads + top-5 priority list.
5. **Evening Manager Report (20:00 IST)** — admin gets: new leads today, hot/warm/cold split, conversions, losses (with reasons), hot leads still not called, total overdue.
6. **`lostReason` field** — API now accepts it when marking a lead lost (app can send it via the existing update endpoints).
7. **AI never re-asks known details** — uses what the lead already told it.

## Flow fixes (v2)

8. **AI steps aside when a human is working the lead.** Any real team action — manual message from the app, setting call status, adding a sales note, or scheduling a follow-up — marks the lead as "human handling" for 24h (`HUMAN_TAKEOVER_COOLING_HOURS`). During that window the AI does not qualify or chat; the customer instead gets one polite acknowledgment ("team aapke touch me hai") at most once every 6 hours, so there is never dead air and never AI interference mid-deal. After the window, AI resumes automatically if the team went quiet.
9. **Sticky ownership.** Once a human has engaged a lead (touch, note, or call status), the AI can still change temperature for reporting, but it can no longer re-assign the lead to a different salesperson. No more leads silently jumping between Ankit and Shivansh mid-conversation.
10. **Hot lead safety net.** When a lead turns hot (or asks for handoff) and has no follow-up scheduled, the system auto-sets `followUpAt` = tomorrow 10:30 IST with reason "Auto: hot lead - contact within 24h". If nobody touches it, it appears 🔴 in the morning digest and the app's overdue queue. No hot lead can silently die.

## Team model (v3): equal distribution + efficiency tracking

**Team = Ankit, Reshu, Shubham (3 salespeople) + 1 Admin.** Shivansh removed.

- **Equal distribution:** every new WhatsApp lead is assigned by **round-robin** (Ankit → Reshu → Shubham → repeat), NOT by temperature. Everyone gets an equal share. Uses an atomic counter in Firestore `settings/assignment`.
- **Sticky ownership:** once assigned, a lead stays with that person. The AI never moves it (temperature still updates for reporting). Only the admin can manually reassign (owner dropdown in the lead screen).
- **Each salesperson sees only their own leads**, across all temperatures (hot/warm/cold tabs now filter within their own pipeline). Backend scopes by the logged-in user automatically.
- **Efficiency tracking:** the admin dashboard shows a per-person card (total, win rate, pipeline, calling) and the evening report includes a per-rep line (leads, open, converted, lost, win %, overdue). Endpoint `GET /api/leads/team/stats` returns the raw numbers.
- **One-time redistribution:** Admin dashboard → "Redistribute Leads Equally" (or `POST /api/leads/team/redistribute`) splits ALL existing leads evenly across the 3 (open leads balanced first). Run this once after deploying.

### App values to set before building the APK (`AppConfig.java`)
- Login PINs: Admin `9090`, Ankit `2026`, Reshu `4040`, Shubham `5050` — **change the sales PINs to your chosen values**.
- Device codes: Ankit is locked to his phone (`A0F9EF19`). Reshu & Shubham are blank = they can log in from any phone with their PIN. After they log in once, read the device code on their login screen and paste it into `RESHU_DEVICE_CODE` / `SHUBHAM_DEVICE_CODE`, then rebuild to lock them to their phones.

## New environment variables (add on Render)

| Variable | Example | Notes |
|---|---|---|
| `ALERT_NUMBER_ANKIT` | `919876543210` | Ankit's personal WhatsApp (10 digits also OK, 91 is auto-added) |
| `ALERT_NUMBER_RESHU` | `919876543211` | Reshu's WhatsApp |
| `ALERT_NUMBER_SHUBHAM` | `919876543212` | Shubham's WhatsApp |
| `ALERT_NUMBER_ADMIN` | `919129172980` | Your (manager) WhatsApp |
| `SALES_TEAM` | `ankit,reshu,shubham` | Team roster (order = round-robin order). Optional; this is the default |
| `RESHU_DEVICE_CODE` | `AB12CD34` | Optional: lock Reshu's backend role to his phone code |
| `SHUBHAM_DEVICE_CODE` | `EF56GH78` | Optional: lock Shubham's backend role to his phone code |
| `SALES_ALERTS_ENABLED` | `true` | Default true. Set `false` to switch off hot alerts |
| `ALERT_COPY_ADMIN` | `true` | Also send every hot alert to admin |
| `HOT_ALERT_COOLDOWN_MINUTES` | `360` | Don't re-alert the same lead within this window (default 6h) |
| `DIGEST_ENABLED` | `true` | Default true. Controls both digests |
| `HUMAN_TAKEOVER_COOLING_HOURS` | `24` | AI stays out of a chat for this long after a team member works the lead |
| `MORNING_DIGEST_TIME` | `09:30` | IST, 24h format |
| `EVENING_DIGEST_TIME` | `20:00` | IST, 24h format |

If a rep's number is missing, their alert falls back to the admin number.

## IMPORTANT: WhatsApp 24-hour window for alerts

Alerts and digests are sent from your **business WhatsApp number** to the team's **personal numbers**. Meta only allows free-form messages to a number that has messaged your business number within the **last 24 hours**.

**Simple fix:** Ankit, Shivansh and you each send any message (even just "hi") from your personal phone to the business number once a day. That keeps the alert window open all day.

**This is safe:** numbers listed in `ALERT_NUMBER_*` are recognized as internal team numbers — the webhook skips them completely. No lead is created, the AI never replies to them, and they never appear in the CRM. This is the ONLY message the team ever sends; all customer chatting stays visible in the app as usual, and reps contact customers by call or their own WhatsApp (the alert includes a one-tap wa.me link).

If an alert fails to deliver, Render logs show `hot_lead_alert_send_failed` with error 131047 = window expired. (A permanent fix is an approved utility template for alerts — can be added later.)

## New files

- `services/leadScoring.js` — buying signals + 0–100 score
- `services/salesAlerts.js` — hot lead WhatsApp alerts
- `services/dailyDigest.js` — morning rep digest + evening manager report

## Modified files

- `config.js` — new env vars
- `services/leadProcessor.js` — signal detection, scoring, alert dispatch
- `services/leadStore.js` — new lead defaults (`leadScore`, `lostReason`, `lastHotAlertAt`), `assigneeForTemperature` export
- `services/aiAgent.js` — one prompt line: never re-ask known details
- `routes/leads.js` — `lostReason`, `leadScore`, `lastHotAlertAt` accepted in updates
- `server.js` — starts digest scheduler
