import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvidDatabase, LibraryRepository } from '../../../packages/core/src/repository';
import { commitNativeEvents, replayNativeJournal, type JournalAdapter } from './nativeJournalReplay';

const databases: AvidDatabase[] = [];
function fixture() {
  const db = new AvidDatabase(`native-replay-${crypto.randomUUID()}`); databases.push(db);
  const repo = new LibraryRepository(db, {profile:{id:'s',name:'Test',url:'https://books.example'},userId:'1'});
  const startedAt = '2026-10-09T10:00:00.000Z', endedAt = '2026-10-09T10:00:15.000Z';
  const progress = {id:'p1',accountScope:repo.scope,bookId:'12',fileId:'31',type:'progress',createdAt:endedAt,readOnly:false,
    payload:{bookId:'12',fileId:'31',kind:'audio',locator:'15',progress:.25,updatedAt:endedAt}};
  const activity = {id:'a1',accountScope:repo.scope,bookId:'12',fileId:'31',type:'activity',createdAt:endedAt,readOnly:false,
    payload:{id:'a1',bookId:'12',kind:'listening',startedAt,duration:15,endedAt}};
  return { db, repo, progress, activity };
}
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });
describe('native journal replay', () => {
  it('commits source timestamps and immutable activity before acknowledging', async () => {
    const {repo,progress,activity} = fixture();
    const journal: JournalAdapter = {drain:vi.fn(async()=>({events:[progress,activity]})),ack:vi.fn(async()=>{
      expect(await repo.getSessions()).toHaveLength(1);
      expect(await repo.pendingOperations()).toHaveLength(2);
    })};
    expect(await replayNativeJournal(journal,repo,false,()=>true)).toBe(2);
    expect(journal.ack).toHaveBeenCalledWith({accountScope:repo.scope,ids:['p1','a1']});
    expect((await repo.pendingOperations()).every(event=>event.occurredAt===progress.createdAt)).toBe(true);
  });
  it('replays a lost acknowledgement without creating duplicate server work', async () => {
    const {repo,progress,activity} = fixture();
    const journal: JournalAdapter = {drain:vi.fn(async()=>({events:[progress,activity]})),ack:vi.fn().mockRejectedValueOnce(new Error('lost ack')).mockResolvedValue(undefined)};
    await expect(replayNativeJournal(journal,repo,false,()=>true)).rejects.toThrow('lost ack');
    const originalIds = (await repo.pendingOperations()).map(event=>event.id).sort();
    await replayNativeJournal(journal,repo,false,()=>true);
    expect((await repo.pendingOperations()).map(event=>event.id).sort()).toEqual(originalIds);
    expect(await repo.getSessions()).toHaveLength(1);
  });
  it('preserves read-only provenance after a writable reconnect, including older unknown-mode events', async () => {
    const {repo,progress,activity} = fixture();
    const {readOnly:_, ...legacy} = activity;
    await commitNativeEvents(repo,[{...progress,readOnly:true},legacy],false);
    expect(await repo.pendingOperations()).toEqual([]);
    expect(await repo.getSessions()).toHaveLength(1);
    expect(await repo.getAnchors()).toHaveLength(1);
  });
  it('keeps writable native events local when the current connection is read-only', async () => {
    const {repo,progress,activity} = fixture();
    await commitNativeEvents(repo,[progress,activity],true);
    await commitNativeEvents(repo,[progress,activity],false);
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it('rejects cross-account events and rolls back a conflicting reused event id', async () => {
    const {repo,progress,activity} = fixture();
    await expect(commitNativeEvents(repo,[{...activity,accountScope:'other-account'}],false)).rejects.toThrow('different account');
    await commitNativeEvents(repo,[activity],false);
    await expect(commitNativeEvents(repo,[progress,{...activity,payload:{...activity.payload,duration:14}}],false)).rejects.toThrow('reused');
    expect(await repo.getAnchors()).toEqual([]);
    expect(await repo.pendingOperations()).toHaveLength(1);
  });
  it('leaves events unacknowledged when an account changes during a native read', async () => {
    const {repo,progress} = fixture(); let active = true;
    const journal: JournalAdapter = {drain:vi.fn(async()=>{active=false;return {events:[progress]};}),ack:vi.fn()};
    expect(await replayNativeJournal(journal,repo,false,()=>active)).toBe(0);
    expect(journal.ack).not.toHaveBeenCalled(); expect(await repo.getAnchors()).toEqual([]);
  });
  it('does not replace a newer backward checkpoint with an older native event', async () => {
    const {repo,progress} = fixture();
    await repo.checkpoint({...progress.payload,kind:'audio',locator:'3',progress:.05,updatedAt:'2026-10-09T11:00:00.000Z'},{readOnly:true});
    await commitNativeEvents(repo,[progress],false);
    expect((await repo.getAnchors())[0]?.locator).toBe('3');
    expect(await repo.pendingOperations()).toEqual([]);
  });
});
