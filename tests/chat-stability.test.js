import { describe, it, expect, vi } from 'vitest';
import { makeCore, seedConversation } from './helpers/core.js';
import { InboundWorker } from '../src/workers/inbound.worker.js';
import { MediaService } from '../src/services/media.service.js';

describe('chat stability', () => {
  it('shares media signing work while rechecking attachment ownership and invalidating changed files', async () => {
    const core=makeCore();const getSignedUrl=vi.fn().mockResolvedValue(['https://example.test/signed']);
    const media=new MediaService({store:core.store,bucket:{file:()=>({getSignedUrl})}});
    await core.store.set('attachments','a',{attachmentId:'a',orgId:'RXDH',storagePath:'original',updatedAt:new Date()});
    await Promise.all([media.get('RXDH','a',{withSignedUrl:true}),media.get('RXDH','a',{withSignedUrl:true})]);
    expect(getSignedUrl).toHaveBeenCalledOnce();
    await expect(media.get('OTHER','a',{withSignedUrl:true})).rejects.toThrow();expect(getSignedUrl).toHaveBeenCalledOnce();
    await core.store.update('attachments','a',{storagePath:'replacement'});
    await media.get('RXDH','a',{withSignedUrl:true});expect(getSignedUrl).toHaveBeenCalledTimes(2);
  });
  it('commits the message before signalling delivery and preserves it if wake-up fails', async () => {
    const core = makeCore(); const { conversation } = await seedConversation(core);
    core.messages.onQueued = vi.fn(() => { throw new Error('wake unavailable'); });
    const result = await core.messages.queueOutbound({ orgId:'RXDH', conversationId:conversation.conversationId, text:'Hello' });
    expect(core.messages.onQueued).toHaveBeenCalledOnce();
    expect((await core.store.get('outbox',result.outbox.outboxId)).status).toBe('PENDING');
    core.messages.onQueued.mockClear();
    await core.messages.queueOutbound({ orgId:'RXDH', conversationId:conversation.conversationId, text:'Decision', metadata:{messageDecisionKey:'key'} });
    expect(core.messages.onQueued).not.toHaveBeenCalled();
  });

  it('keeps local read state even when Meta rejects the receipt, without repeatedly calling Meta', async () => {
    const core = makeCore(); const {conversation,contact} = await seedConversation(core);
    const saved = await core.messages.createInbound({ orgId:'RXDH',conversationId:conversation.conversationId,contactId:contact.contactId,channel:'WHATSAPP',channelAccountId:'WA_RX_01',providerMessageId:'wamid.old',text:'Hello' });
    const markAsRead = vi.fn().mockRejectedValue(Object.assign(new Error('(#100) Invalid parameter'),{code:100}));
    core.messages.channelManager = {markAsRead};
    const result = await core.messages.markRead('RXDH',saved.message.messageId);
    expect(result.status).toBe('READ'); expect(result.providerReadReceipt.status).toBe('FAILED'); expect(result.conversationUnreadCount).toBe(0);
    await core.messages.markRead('RXDH',saved.message.messageId); expect(markAsRead).toHaveBeenCalledOnce();
    const outbound = await core.messages.queueOutbound({orgId:'RXDH',conversationId:conversation.conversationId,text:'Hi'});
    await expect(core.messages.markRead('RXDH',outbound.message.messageId)).rejects.toThrow('Only incoming');
    expect((await core.messages.get('RXDH',outbound.message.messageId)).status).toBe('QUEUED');
  });

  it('recovers interrupted inbound events but does not steal a fresh processing lock', async () => {
    const core=makeCore();
    for(const [id,age] of [['stale',360000],['busy',1000]])await core.store.set('webhookEvents',id,{webhookEventId:id,orgId:'RXDH',processingStatus:'PROCESSING',lockedAt:new Date(Date.now()-age),receivedAt:new Date(Date.now()-age),attemptCount:1});
    const processEvent=vi.fn(async id=>core.store.update('webhookEvents',id,{processingStatus:'PROCESSED'}));
    const worker=new InboundWorker({store:core.store,webhookService:{orgId:'RXDH',processEvent},notifications:core.notifications,intervalMs:15000,batchSize:20,logger:{error:vi.fn()}});
    await worker.tick();expect(processEvent).toHaveBeenCalledExactlyOnceWith('stale');
    expect((await core.store.get('webhookEvents','busy')).processingStatus).toBe('PROCESSING');
  });
});
