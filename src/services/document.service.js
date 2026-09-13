import PDFDocument from "pdfkit";
import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";

export class DocumentService {
  constructor({ domain, media, messages, store }) {
    this.domain = domain;
    this.media = media;
    this.messages = messages;
    this.store = store;
  }

  async generateQuotationPdf(orgId, quotationId) {
    const quotation = await this.domain.get("quotations", orgId, quotationId);
    const buffer = await renderQuotation(quotation);
    const attachment = await this.media.storeBuffer({
      orgId,
      contactId: quotation.contactId,
      conversationId: quotation.conversationId || null,
      messageId: null,
      buffer,
      mimeType: "application/pdf",
      originalFilename: `${quotationId}.pdf`
    });
    await this.store.update(COLLECTIONS.quotations, quotationId, {
      pdfAttachmentId: attachment.attachmentId,
      pdfGeneratedAt: now(),
      updatedAt: now()
    });
    return attachment;
  }

  async sendQuotation(orgId, quotationId, actor) {
    const quotation = await this.domain.get("quotations", orgId, quotationId);
    const attachment = quotation.pdfAttachmentId
      ? await this.media.get(orgId, quotation.pdfAttachmentId)
      : await this.generateQuotationPdf(orgId, quotationId);
    const queued = await this.messages.queueOutbound({
      orgId,
      conversationId: quotation.conversationId,
      text: `Quotation ${quotationId} from RX Design Hub`,
      type: "DOCUMENT",
      attachmentIds: [attachment.attachmentId],
      senderType: "AGENT",
      senderId: actor.userId,
      metadata: { quotationId },
      idempotencyKey: `QUOTATION:${quotationId}:${quotation.updatedAt?.toMillis?.() || quotation.updatedAt || "v1"}`
    });
    await this.domain.update("quotations", orgId, quotationId, { status: "SENT", sentAt: now() }, actor, "SENT");
    if (quotation.leadId) {
      await this.domain.update("leads", orgId, quotation.leadId, { leadStatus: "QUOTATION_SENT", quotationSent: true }, actor, "STATUS_CHANGED");
    }
    return queued;
  }
}

function renderQuotation(quotation) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(20).text("RX Design Hub", { align: "center" });
    doc.moveDown(0.4).fontSize(14).text(`Quotation ${quotation.quotationId}`, { align: "center" });
    doc.moveDown().fontSize(10).text(`Currency: ${quotation.currency || "INR"}`);
    doc.text(`Status: ${quotation.status || "DRAFT"}`);
    doc.moveDown();
    for (const item of quotation.items || []) {
      doc.text(`${item.lineNumber || "-"}. ${item.description}`);
      doc.text(`   ${item.quantity} x ${money(item.unitPrice)} = ${money(item.lineTotal)}`);
    }
    doc.moveDown().fontSize(11).text(`Subtotal: ${money(quotation.subtotal)}`, { align: "right" });
    if (quotation.taxAmount) doc.text(`Tax: ${money(quotation.taxAmount)}`, { align: "right" });
    if (quotation.discountAmount) doc.text(`Discount: ${money(quotation.discountAmount)}`, { align: "right" });
    doc.fontSize(13).text(`Total: ${money(quotation.totalAmount)}`, { align: "right" });
    if (quotation.notes) doc.moveDown().fontSize(9).text(quotation.notes);
    doc.moveDown(2).fontSize(9).text("This quotation is system-generated. Commercial commitments remain subject to authorized confirmation.");
    doc.end();
  });
}

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value || 0));
}
