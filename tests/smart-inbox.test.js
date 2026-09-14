import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeCore, seedConversation } from './helpers/core.js';
import { smartInboxRoutes } from '../src/routes/smart-inbox.routes.js';
import { messagePolicyRoutes } from '../src/routes/message-policy.routes.js';
import { SmartMessageService } from '../src/services/smart-message.service.js';
import { OutboundWorker } from '../src/workers/outbound.worker.js';
import { decodeCursor } from '../src/utils/pagination.js';

const owner = { orgId:'RXDH', userId:'OWNER_1', role:'OWNER' };
function app(core, actor=owner) {
  const server=express(); server.use(express.json()); server.use((req,_res,next)=>{req.auth=actor;next();});
  server.use(smartInboxRoutes(core)); server.use(messagePolicyRoutes(core));
  server.use((error,_req,res,_next)=>res.status(error.status || error.statusCode || 500).json({error:error.message}));return server;
}
function worker(core,send=vi.fn().mockResolvedValue({providerMessageId:'provider-sent'})) {
  const value=new OutboundWorker({...core,channelManager:{send},media:{prepareForSend:async()=>[]},intervalMs:5000,batchSize:20,maxAttempts:5,retryDelays:[1,60000],workerId:'test',logger:{warn(){},error(){}}});return {value,send};
}

describe('smart client inbox',()=>{
  it('isolates preferences by authenticated user and blocks out-of-scope access',async()=>{
    const core=makeCore();const {conversation,contact}=await seedConversation(core); const id=conversation.conversationId;
    await core.store.update('contacts',contact.contactId,{relationshipType:'EXISTING_CLIENT',assignedTo:'OTHER'});
    expect((await request(app(core)).patch(`/conversations/${id}/preferences`).send({pinned:true,draft:'Private draft',muted:true})).status).toBe(200);
    expect((await request(app(core,{...owner,userId:'OWNER_2'})).get(`/conversations/${id}/preferences`)).body.data).toEqual({});
    const restricted={...owner,userId:'SALES_1',role:'SALES',clientScope:'PROSPECT',permissions:['conversations.read_assigned']};
    expect((await request(app(core,restricted)).get(`/conversations/${id}/preferences`)).status).toBe(403);
    expect((await request(app(core)).patch(`/conversations/${id}/preferences`).send({userId:'OTHER'})).status).toBe(400);
  });
  it('applies identical access checks to smart-send and message decisions',async()=>{
    const core=makeCore();const {conversation,contact}=await seedConversation(core);
    await core.store.update('contacts',contact.contactId,{relationshipType:'EXISTING_CLIENT'});
    core.smartMessages=new SmartMessageService(core);
    const actor={...owner,role:'SALES',clientScope:'PROSPECT',permissions:['messages.send']};
    for(const route of ['smart-send','decide']) {
      const response=await request(app(core,actor)).post(`/message/${route}`).send({contactId:contact.contactId,conversationId:conversation.conversationId,eventType:'CUSTOMER_REQUEST',textMessage:'Hello',requestedByCustomer:true});
      expect(response.status).toBe(403);
    }
    expect((await core.store.find('outbox')).items).toHaveLength(0);
  });
  it('AI suggestion returns reviewable text without sending or changing client facts',async()=>{
    const core=makeCore();const {conversation,contact}=await seedConversation(core);
    await core.messages.createInbound({orgId:'RXDH',conversationId:conversation.conversationId,contactId:contact.contactId,channel:'WHATSAPP',channelAccountId:'WA_RX_01',providerMessageId:'inbound',text:'Delivery date?'});
    core.ai={client:{},generate:vi.fn().mockResolvedValue({reply:'I will check the dispatch schedule.',reason:'Confirm the order first',needsHuman:true,leadUpdates:{paymentStatus:'PAID'}})};
    const response=await request(app(core)).post(`/conversations/${conversation.conversationId}/suggest`).send({});
    expect(response.status).toBe(200);expect(response.body.data.reply).toContain('dispatch');
    expect((await core.store.find('outbox')).items).toHaveLength(0);
    expect((await core.store.get('contacts',contact.contactId)).paymentStatus).not.toBe('PAID');
  });
  it('walks all scoped pages without skipping matching clients',async()=>{
    const core=makeCore();
    for(let i=0;i<235;i++){
      await core.store.set('contacts',`c${i}`,{contactId:`c${i}`,orgId:'RXDH',relationshipType:i%2?'PROSPECT':'EXISTING_CLIENT'});
      await core.store.set('conversations',`v${i}`,{conversationId:`v${i}`,contactId:`c${i}`,orgId:'RXDH',currentChannel:'WHATSAPP',updatedAt:new Date(1000+i)});
    }
    let cursor=null;const found=[];
    do{const result=await core.conversations.list('RXDH',{limit:100,relationshipTypes:['EXISTING_CLIENT'],sortBy:'updatedAt',sortOrder:'asc',cursor});found.push(...result.items);cursor=result.pagination.hasMore?decodeCursor(result.pagination.nextCursor):null;}while(cursor);
    expect(found).toHaveLength(118);expect(new Set(found.map(i=>i.conversationId)).size).toBe(118);
  });
  it('adds and removes due-followup metadata on the conversation list',async()=>{
    const core=makeCore();const {conversation,contact}=await seedConversation(core);
    const before=new Date(1000);await core.store.update('conversations',conversation.conversationId,{updatedAt:before});
    const dueAt=new Date(Date.now()+3600000);const followup=await core.domain.create('followUps','RXDH',{contactId:contact.contactId,conversationId:conversation.conversationId,dueAt});
    let listed=await core.conversations.list('RXDH',{limit:100});expect(listed.items[0].nextFollowUpAt).toEqual(dueAt);expect(listed.items[0].updatedAt.getTime()).toBeGreaterThan(before.getTime());
    await core.domain.update('followUps','RXDH',followup.followUpId,{status:'COMPLETED'});
    listed=await core.conversations.list('RXDH',{limit:100});expect(listed.items[0].nextFollowUpAt).toBeNull();
  });
  it('keeps a newer incoming message unread when an earlier message is marked read',async()=>{
    const core=makeCore();const {conversation,contact}=await seedConversation(core);
    const input={orgId:'RXDH',conversationId:conversation.conversationId,contactId:contact.contactId,channel:'WHATSAPP',channelAccountId:'WA_RX_01',text:'Hello'};
    const first=await core.messages.createInbound({...input,providerMessageId:'p1'});await core.messages.createInbound({...input,providerMessageId:'p2'});
    await core.messages.markRead('RXDH',first.message.messageId,owner);
    expect((await core.conversations.get('RXDH',conversation.conversationId)).unreadCount).toBe(1);
  });
  it('does not reopen a reply window when an old provider message arrives late',async()=>{
    const core=makeCore();const {conversation,contact}=await seedConversation(core);
    await core.store.update('conversations',conversation.conversationId,{lastInboundAt:null});
    const at=new Date(Date.now()-30*3600000);
    await core.messages.createInbound({orgId:'RXDH',conversationId:conversation.conversationId,contactId:contact.contactId,channel:'WHATSAPP',providerMessageId:'late',providerTimestamp:at});
    expect((await core.conversations.get('RXDH',conversation.conversationId)).lastInboundAt).toEqual(at);
  });
  it('stops an already-queued message after opt-out and after window expiry',async()=>{
    for(const condition of ['STOP','EXPIRED']){
      const core=makeCore();const {conversation,contact}=await seedConversation(core);
      await core.messages.queueOutbound({orgId:'RXDH',conversationId:conversation.conversationId,text:'Pending reply'});
      if(condition==='STOP')await core.store.update('contacts',contact.contactId,{suppressed:true});
      else await core.store.update('conversations',conversation.conversationId,{lastInboundAt:new Date(Date.now()-25*3600000)});
      const {value,send}=worker(core);await value.tick();expect(send).not.toHaveBeenCalled();
      expect((await core.store.find('outbox')).items[0].status).toBe('FAILED');
    }
  });
  it('quarantines stale delivery claims instead of silently retrying or abandoning them',async()=>{
    const core=makeCore();const {conversation}=await seedConversation(core);
    await core.messages.queueOutbound({orgId:'RXDH',conversationId:conversation.conversationId,text:'Uncertain delivery'});
    const record=(await core.store.find('outbox')).items[0];await core.store.update('outbox',record.outboxId,{status:'PROCESSING',lockedAt:new Date(Date.now()-10*60000)});
    const {value,send}=worker(core);await value.tick();expect(send).not.toHaveBeenCalled();
    expect((await core.store.get('outbox',record.outboxId)).status).toBe('DELIVERY_UNKNOWN');
    expect((await core.store.get('messages',record.messageId)).status).toBe('DELIVERY_UNKNOWN');
  });
});
