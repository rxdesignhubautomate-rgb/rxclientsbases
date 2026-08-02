# Order-confirmation Utility video setup

Create this template in the same WhatsApp Business Account and phone-number setup used by the CRM.

- Template name: `rx_order_confirmation`
- Category: `Utility`
- Language: `English` (`en` or the single approved regional English variant used by the account)
- Header: `Video`
- Body:

```text
Hello {{1}}, your order {{2}} has been confirmed. Order value: {{3}}. We will share the next update here.
```

Suggested example values:

1. Rahul
2. ORD-1001
3. INR 25,000

Do not add promotional copy, offers, catalogues, cross-sell or upsell content to this Utility template or its video. Meta may reclassify or reject such content.

After Meta shows the template as **Active / Approved**:

1. Deploy backend `2.9.5` to Render.
2. Deploy frontend `1.9.4` to Vercel.
3. In CRM Marketing, click **Sync from Meta**.
4. Confirm `rx_order_confirmation` appears as Approved and the configured duplicate video template is no longer listed.
5. For one order, select one existing client, enter that client's real CRM order ID and order value, upload the order-specific video, then choose **Verify order & queue video update**.
6. For multiple orders, open **Verified Order Batch**, upload one genuine order-confirmation video, select up to 50 active orders, confirm the transactional-use declaration, and choose **Verify & queue selected orders**.

The backend verifies every selected order independently. It rejects or skips orders that are missing, terminal, linked to another customer type, duplicated, or otherwise ineligible. The template must be approved and the uploaded header must be a video.
