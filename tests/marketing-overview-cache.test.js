import {it,expect,vi} from 'vitest';
import {cachedMarketingOverview} from '../src/services/marketing-overview-cache.js';
import {MemoryStore} from './helpers/memory-store.js';

it('shares repeated counts within 30 seconds, isolates scope and refreshes after expiry',async()=>{
  vi.useFakeTimers();
  try {
    const store=new MemoryStore({contacts:{a:{orgId:'RXDH',contactId:'a',relationshipType:'EXISTING_CLIENT'}}});
    const reads=vi.spyOn(store,'find');
    const actor={role:'ADMIN',userId:'admin'};
    const [one,two]=await Promise.all([cachedMarketingOverview(store,'RXDH',actor),cachedMarketingOverview(store,'RXDH',actor)]);
    expect(one.totalContacts).toBe(1);expect(two).toEqual(one);expect(reads).toHaveBeenCalledTimes(2);
    await cachedMarketingOverview(store,'RXDH',actor);expect(reads).toHaveBeenCalledTimes(2);
    const prospect=await cachedMarketingOverview(store,'RXDH',{role:'SALES',clientScope:'PROSPECT',userId:'sales'});
    expect(prospect.totalContacts).toBe(0);
    expect((await cachedMarketingOverview(store,'OTHER',actor)).totalContacts).toBe(0);
    await store.set('contacts','b',{orgId:'RXDH',contactId:'b'});
    vi.advanceTimersByTime(30_001);
    expect((await cachedMarketingOverview(store,'RXDH',actor)).totalContacts).toBe(2);
  }finally{vi.useRealTimers();}
});

it('does not retain failed count queries',async()=>{
  const store=new MemoryStore();const find=vi.spyOn(store,'find').mockRejectedValueOnce(new Error('offline'));
  await expect(cachedMarketingOverview(store,'RXDH')).rejects.toThrow('offline');
  expect((await cachedMarketingOverview(store,'RXDH')).totalContacts).toBe(0);
  expect(find.mock.calls.length).toBeGreaterThan(2);
});
