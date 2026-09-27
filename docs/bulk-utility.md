# Bulk Utility templates

Backend 2.18.0-dev.6; frontend 1.17.0-dev.4.

Owners and admins can open **Marketing → Bulk Utility** to send any approved Utility template synced from Meta to active, linked existing-client orders.

## Operator flow

1. Select **Sync Meta templates** after Meta approves a new template.
2. Select the approved Utility template.
3. Review or edit each variable mapping. Supported per-order placeholders include `{{customer_name}}`, `{{company_name}}`, `{{contact_person}}`, `{{order_reference}}`, `{{order_value}}`, `{{amount_due}}`, `{{order_status}}`, `{{city}}`, `{{courier_name}}`, and `{{tracking_reference}}`.
4. Upload the template header asset when the approved template requires image, video, or document media.
5. Search and select up to 50 active orders, check the preview, confirm transactional use, and send.

The server excludes messages for the same template and order that were already sent, queued, or have uncertain delivery. It also excludes terminal orders, suppressed/blocked/STOP and opted-out contacts, prospects, and duplicate destination numbers. Confirmed failed messages remain retryable.

The generic API is `POST /events/utility/batch`; eligible orders are listed by `GET /events/utility/batch/orders`.
