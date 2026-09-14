import { describe, it, expect } from 'vitest';
import { makeCore, seedConversation } from './helpers/core.js';
import { QuotationService, quotationTotals } from '../src/services/quotation.service.js';
import { DocumentService } from '../src/services/document.service.js';

const actor = { userId:'USR_ADMIN',name:'Admin',role:'ADMIN' };
async function setup() {
  const core = makeCore();
  const {contact,conversation} = await seedConversation(core);
  const quotes = new QuotationService(core);
  const input = {contactId:contact.contactId,conversationId:conversation.conversationId,clientRequestId:'request-quotation-1',gstPercent:18,items:[{description:'Visual Aid · Gloss 5 pages',product:'Visual Aid',variety:'Gloss 5 pages',quantity:10,unitPrice:400}]};
  const quote = await quotes.create('RXDH',input,actor);
  await core.store.create('attachments','ATT_PDF',{attachmentId:'ATT_PDF',orgId:'RXDH',contactId:contact.contactId,conversationId:conversation.conversationId,mimeType:'application/pdf'});
  const docs = new DocumentService({...core,media:{get:async (org,id) => core.store.get('attachments',id)}});
  return {...core,contact,conversation,quotes,quote,input,docs};
}

describe('quotation drafts and manual sending', () => {
  it('rounds line values and GST to paise with consistent totals', () => {
    expect(quotationTotals({gstPercent:18,items:[{quantity:3,unitPrice:10.335},{quantity:2,unitPrice:2.22}]})).toMatchObject({subtotal:35.45,taxAmount:6.38,totalAmount:41.83});
  });
  it('creates a stable draft, embeds all items atomically, and does not enqueue', async () => {
    const c = await setup();
    const again = await c.quotes.create('RXDH',c.input,actor);
    expect(again.quotationId).toBe(c.quote.quotationId);
    expect(again).toMatchObject({status:'DRAFT',revision:1,subtotal:4000,taxAmount:720,totalAmount:4720});
    expect(again.items).toHaveLength(1);
    expect(await c.store.count('outbox')).toBe(0);
    expect(await c.store.count('quotations')).toBe(1);
  });
  it('rejects foreign conversation and attachment links', async () => {
    const c = await setup();
    await c.store.set('conversations','WRONG',{orgId:'OTHER',contactId:c.contact.contactId});
    await expect(c.quotes.create('RXDH',{...c.input,clientRequestId:'another-request',conversationId:'WRONG'},actor)).rejects.toThrow(/links/);
    await c.store.set('attachments','OTHER',{orgId:'RXDH',contactId:'ANOTHER',mimeType:'application/pdf'});
    await expect(c.quotes.attachPdf('RXDH',c.quote.quotationId,{attachmentId:'OTHER',expectedRevision:1})).rejects.toThrow(/PDF/);
  });
  it('editing invalidates PDF and old revision cannot overwrite a new draft', async () => {
    const c = await setup();
    await c.quotes.attachPdf('RXDH',c.quote.quotationId,{attachmentId:'ATT_PDF',expectedRevision:1});
    const updated = await c.quotes.update('RXDH',c.quote.quotationId,{...c.input,expectedRevision:1,items:[{description:'Updated',quantity:2,unitPrice:500}]});
    expect(updated).toMatchObject({revision:2,totalAmount:1180,pdfAttachmentId:null});
    await expect(c.quotes.update('RXDH',c.quote.quotationId,{...c.input,expectedRevision:1})).rejects.toThrow(/changed/);
    await expect(c.quotes.attachPdf('RXDH',c.quote.quotationId,{attachmentId:'ATT_PDF',expectedRevision:1})).rejects.toThrow(/changed/);
    await expect(c.docs.sendQuotation('RXDH',c.quote.quotationId,actor)).rejects.toThrow(/current/);
  });
  it('queues the saved PDF once, locks the draft, and repeated send returns its existing message even after the reply window closes', async () => {
    const c = await setup();
    await c.quotes.attachPdf('RXDH',c.quote.quotationId,{attachmentId:'ATT_PDF',expectedRevision:1});
    const first = await c.docs.sendQuotation('RXDH',c.quote.quotationId,actor);
    expect(first.message.attachmentIds).toEqual(['ATT_PDF']);
    expect(first.message.contactId).toBe(c.contact.contactId);
    expect((await c.domain.get('quotations','RXDH',c.quote.quotationId)).status).toBe('QUEUED');
    await c.store.update('conversations',c.conversation.conversationId,{lastInboundAt:new Date(0)});
    const repeat = await c.docs.sendQuotation('RXDH',c.quote.quotationId,actor);
    expect(repeat.message.messageId).toBe(first.message.messageId);
    expect(await c.store.count('outbox')).toBe(1);
    await expect(c.quotes.update('RXDH',c.quote.quotationId,{...c.input,expectedRevision:1})).rejects.toThrow(/locked/);
  });
  it('a closed reply window leaves the saved draft editable without queueing', async () => {
    const c = await setup();
    await c.quotes.attachPdf('RXDH',c.quote.quotationId,{attachmentId:'ATT_PDF',expectedRevision:1});
    await c.store.update('conversations',c.conversation.conversationId,{lastInboundAt:new Date(0)});
    await expect(c.docs.sendQuotation('RXDH',c.quote.quotationId,actor)).rejects.toThrow(/24-hour/);
    expect((await c.domain.get('quotations','RXDH',c.quote.quotationId)).status).toBe('DRAFT');
    expect(await c.store.count('outbox')).toBe(0);
  });
  it('an edit between preview and queue commit prevents sending a stale PDF', async () => {
    const c = await setup();
    await c.quotes.attachPdf('RXDH',c.quote.quotationId,{attachmentId:'ATT_PDF',expectedRevision:1});
    const original = c.messages.queueOutbound.bind(c.messages);
    c.messages.queueOutbound = async args => {
      await c.quotes.update('RXDH',c.quote.quotationId,{...c.input,expectedRevision:1});
      return original(args);
    };
    await expect(c.docs.sendQuotation('RXDH',c.quote.quotationId,actor)).rejects.toThrow(/changed/);
    expect(await c.store.count('outbox')).toBe(0);
  });
});
