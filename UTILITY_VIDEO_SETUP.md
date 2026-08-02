# Order-confirmation Utility video setup

Create this template in the same WhatsApp Business Account and phone-number setup used by the CRM.

- Template name: `rx_order_confirmation_video`
- Category: `Utility`
- Language: `English` (`en` or the single approved regional English variant used by the account)
- Header: `Video`
- Body:

```text
Hello {{1}}, your order {{2}} has been confirmed. Order value: {{3}}. The attached video contains information related to this order. We will share the next update here.
```

Suggested example values:

1. Rahul
2. ORD-1001
3. INR 25,000

Do not add promotional copy, offers, catalogues, cross-sell or upsell content to this Utility template or its video. Meta may reclassify or reject such content.

After Meta shows the template as **Active / Approved**:

1. Deploy backend `2.9.3` to Render.
2. Deploy frontend `1.9.2` to Vercel.
3. In CRM Marketing, click **Sync from Meta**.
4. Confirm `rx_order_confirmation_video` appears as Approved.
5. Select one existing client, enter that client's real CRM order ID and order value, upload the order-specific video, then choose **Verify order & queue video update**.

The backend rejects the send when the order is missing, belongs to another client, the template is not approved, the uploaded file is not a video, or the attachment belongs to another client.
