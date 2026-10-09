import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {AvidDatabase,LibraryRepository,accountScope} from '../src/repository';
import type {Annotation,ReadingAnchor,Session} from '../src/types';
const session:Session={profile:{id:'server',name:'One',url:'https://books.example'},userId:'1',accessToken:'not-stored'};
const anchor:ReadingAnchor={bookId:'4',fileId:'5',kind:'epub',locator:'epubcfi(/6/2)',progress:0.5,updatedAt:'2026-10-09T10:00:00Z'};
const note:Annotation={id:'local-note',bookId:'4',fileId:'5',kind:'note',quote:'A sentence',text:'Remember',color:'yellow',locator:'epubcfi(/6/2)',createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt};
let db:AvidDatabase;
beforeEach(()=>{db=new AvidDatabase(`test-${crypto.randomUUID()}`);});
afterEach(async()=>{await db.delete();});
describe('account-scoped repository',()=>{
  it('separates accounts and servers while ignoring token rotation and profile labels',async()=>{
    const a=new LibraryRepository(db,session);
    const b=new LibraryRepository(db,{...session,userId:'2'});
    const c=new LibraryRepository(db,{...session,profile:{...session.profile,url:'https://other.example'}});
    await a.checkpoint(anchor);
    expect(await b.getAnchors()).toEqual([]); expect(await c.pendingOperations()).toEqual([]);
    expect(accountScope({...session,profile:{...session.profile,name:'Renamed'}})).toBe(a.scope);
    expect(JSON.stringify(await db.outbox.toArray())).not.toContain('not-stored');
  });
  it('atomically stores the latest exact checkpoint and coalesces pending progress',async()=>{
    const repo=new LibraryRepository(db,session);
    await repo.checkpoint(anchor);
    await repo.checkpoint({...anchor,locator:'epubcfi(/6/4)',progress:0.2,updatedAt:'2026-10-09T11:00:00Z'});
    expect((await repo.getAnchor(anchor))?.progress).toBe(0.2); // Backward seeks are valid.
    const pending=await repo.pendingOperations(); expect(pending).toHaveLength(1);
    expect(pending[0].occurredAt).toBe('2026-10-09T11:00:00Z');
    await repo.checkpoint({...anchor,updatedAt:'2026-10-09T09:00:00Z'});
    expect((await repo.getAnchor(anchor))?.progress).toBe(0.2);
  });
  it('keeps read-only activity on-device without server mutation intents',async()=>{
    const repo=new LibraryRepository(db,session);
    await repo.checkpoint(anchor,{readOnly:true}); await repo.putAnnotation(note,{readOnly:true});
    expect(await repo.getAnchors()).toHaveLength(1); expect(await repo.getAnnotations()).toHaveLength(1);
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it('preserves deletion tombstones while importing stale server notes',async()=>{
    const repo=new LibraryRepository(db,session);
    await repo.putAnnotation({...note,id:'12',deleted:true});
    await repo.importAnnotations([{...note,id:'12'}]);
    expect(await repo.getAnnotations()).toEqual([]);
    expect((await repo.getAnnotations(undefined,true))[0].deleted).toBe(true);
  });
  it('clears only the selected account',async()=>{
    const one=new LibraryRepository(db,session),two=new LibraryRepository(db,{...session,userId:'2'});
    await one.checkpoint(anchor); await two.checkpoint(anchor); await one.clearAccount();
    expect(await one.getAnchors()).toEqual([]); expect(await two.getAnchors()).toHaveLength(1);
  });
  it('does not enqueue an already committed immutable activity chunk after a callback retry',async()=>{
    const repo=new LibraryRepository(db,session);const activity={id:'immutable-1',bookId:'4',kind:'listening' as const,startedAt:'2026-10-09T00:00:00Z',duration:30};
    const endedAt='2026-10-09T00:02:00Z';
    await repo.recordSession(activity,'5',{endedAt});await repo.recordSession(activity,'5',{endedAt});
    expect(await repo.pendingOperations()).toHaveLength(1);
    const [operation]=await repo.pendingOperations();expect(operation.payload).toMatchObject({endedAt});
    await repo.acknowledge(operation.id);await repo.recordSession(activity,'5',{endedAt});
    expect(await repo.pendingOperations()).toHaveLength(0);
    await expect(repo.recordSession({...activity,duration:40},'5',{endedAt})).rejects.toThrow('immutable');
    expect(await repo.getSessions()).toHaveLength(1);
  });
});
