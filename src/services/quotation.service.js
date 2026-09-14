import { createId } from '../utils/ids.js';
import { sha256 } from '../utils/hashing.js';
import { now } from '../utils/dates.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';

export function quotationTotals(input) {
  const items = (input.items || []).map((item, index) => ({ ...item, lineNumber: index + 1, lineTotal: Math.round(item.quantity * item.unitPrice * 100) / 100 }));
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  const taxAmount = input.gstPercent == null ? Number(input.taxAmount || 0) : Math.round(subtotal * input.gstPercent) / 100;
  const discountAmount = Number(input.discountAmount || 0);
  if (![subtotal,taxAmount,discountAmount].every(Number.isFinite) || subtotal > 1e10 || discountAmount > subtotal + taxAmount) throw new ConflictError('Invalid quotation totals');
  return { itemsSnapshot: items, subtotal, taxAmount, discountAmount, totalAmount: Math.round((subtotal + taxAmount - discountAmount) * 100) / 100 };
}

export class QuotationService {
  constructor({store,domain,audit}) { Object.assign(this,{store,domain,audit}); }

  async validateLinks(tx, orgId, input) {
    const contact = await tx.get('contacts',input.contactId);
    if (!contact || contact.orgId !== orgId) throw new NotFoundError('Contact');
    for (const [collection,key] of [['conversations','conversationId'],['leads','leadId']]) {
      if (!input[key]) continue;
      const linked = await tx.get(collection,input[key]);
      if (!linked || linked.orgId !== orgId || linked.contactId !== input.contactId) throw new ConflictError('Quotation links must belong to the selected client');
    }
    return contact;
  }

  async create(orgId,input,actor={}) {
    const id = input.clientRequestId ? `QUO_${sha256(`${orgId}:${actor.userId}:${input.clientRequestId}`).slice(0,26).toUpperCase()}` : createId('quotation');
    const timestamp = now();
    await this.store.runTransaction(async tx => {
      const existing = await tx.get('quotations',id);
      if (existing) {
        if(existing.contactId !== input.contactId) throw new ConflictError('Request key already used for another client');
        return;
      }
      const contact = await this.validateLinks(tx,orgId,input);
      const record = { ...input, ...quotationTotals(input), quotationId:id, orgId, status:'DRAFT', revision:1,
        quotationNumber:input.quotationNumber || `RX-${id.slice(-8).toUpperCase()}`,
        companyName:input.companyName || contact.companyName || contact.contactPerson || 'Customer',
        phone:input.phone || contact.primaryPhone || '',city:input.city || contact.city || '',
        assignedTo:contact.assignedTo || actor.userId || null,preparedBy:input.preparedBy || actor.name || actor.userId || 'RX Team',
        createdAt:timestamp,updatedAt:timestamp };
      delete record.items; delete record.expectedRevision;
      tx.create('quotations',id,record);
      tx.create('auditLogs',`AUD_${id}`,{auditLogId:`AUD_${id}`,orgId,actorId:actor.userId || 'SYSTEM',action:'QUOTATION_CREATED',entityType:'QUOTATION',entityId:id,createdAt:timestamp});
    });
    return this.domain.get('quotations',orgId,id);
  }

  async update(orgId,id,input) {
    await this.store.runTransaction(async tx => {
      const before = await tx.get('quotations',id);
      if (!before || before.orgId !== orgId) throw new NotFoundError('Quotation');
      if (before.status !== 'DRAFT') throw new ConflictError('This quotation is locked. Create a new quotation for changes.');
      if (input.contactId && input.contactId !== before.contactId) throw new ConflictError('Changing the linked client is not supported');
      if (Number(input.expectedRevision) !== Number(before.revision || 1)) throw new ConflictError('Quotation changed. Reopen it before editing.');
      const merged = {...before,...input};
      await this.validateLinks(tx,orgId,merged);
      const patch = {...input,...quotationTotals({...merged,items:input.items || before.itemsSnapshot || []}),revision:Number(before.revision || 1)+1,pdfAttachmentId:null,pdfRevision:null,updatedAt:now()};
      if (!patch.itemsSnapshot.length) throw new ConflictError('Provide quotation items');
      delete patch.items;delete patch.expectedRevision;delete patch.clientRequestId;delete patch.assignedTo;
      tx.update('quotations',id,patch);
    });
    return this.domain.get('quotations',orgId,id);
  }

  async attachPdf(orgId,id,{attachmentId,expectedRevision}) {
    await this.store.runTransaction(async tx => {
      const quote = await tx.get('quotations',id);
      const attachment = await tx.get('attachments',attachmentId);
      if(!quote || quote.orgId !== orgId) throw new NotFoundError('Quotation');
      if(quote.status !== 'DRAFT' || Number(expectedRevision)!==Number(quote.revision || 1)) throw new ConflictError('Quotation changed. Generate a new preview.');
      if(!attachment || attachment.orgId !== orgId || attachment.contactId !== quote.contactId || attachment.mimeType !== 'application/pdf' || (attachment.conversationId && attachment.conversationId !== quote.conversationId)) throw new ConflictError('Choose a PDF belonging to this quotation client');
      tx.update('quotations',id,{pdfAttachmentId:attachmentId,pdfRevision:quote.revision || 1,pdfGeneratedAt:now(),updatedAt:now()});
    });
    return this.domain.get('quotations',orgId,id);
  }
}
