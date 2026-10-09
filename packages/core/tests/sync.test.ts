import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AvidDatabase,LibraryRepository} from '../src/repository';
import {BookOrbitClient,ProgressConflictError} from '../src/bookorbit';
import {SyncCoordinator} from '../src/sync';
import type {Annotation,ReadingAnchor,Session} from '../src/types';
const session:Session={profile:{id:'s',name:'One',url:'https://books.example'},userId:'1',accessToken:'token'};
const anchor:ReadingAnchor={bookId:'4',fileId:'5',kind:'epub',locator:'epubcfi(/6/2)',progress:0.2,updatedAt:'2026-10-09T10:00:00Z'};
let db:AvidDatabase,repo:LibraryRepository;
beforeEach(()=>{db=new AvidDatabase(`test-${crypto.randomUUID()}`);repo=new LibraryRepository(db,session);});
afterEach(async()=>{await db.delete();});
describe('synchronization safety',()=>{
  it('keeps a pending intent when account ownership changes during the read before a write',async()=>{
    await repo.checkpoint(anchor);let active=true;
    const client=new BookOrbitClient(session);
    vi.spyOn(client,'getProgress').mockImplementation(async()=>{active=false;return null;});
    const save=vi.spyOn(client,'saveProgress').mockResolvedValue();
    expect((await new SyncCoordinator(repo,client,{isActive:()=>active}).flush()).sent).toBe(0);
    expect(save).not.toHaveBeenCalled();expect((await repo.pendingOperations())[0].status).toBe('pending');
  });
  it('drains checkpoints committed while a shared flush is already running',async()=>{
    await repo.checkpoint(anchor);const client=new BookOrbitClient(session);
    vi.spyOn(client,'getProgress').mockResolvedValue(null);
    const save=vi.spyOn(client,'saveProgress').mockImplementation(async value=>{
      if(value.locator===anchor.locator)await repo.checkpoint({...anchor,locator:'epubcfi(/6/4)',progress:.3,updatedAt:'2026-10-09T10:01:00Z'});
    });
    expect((await new SyncCoordinator(repo,client).flush()).sent).toBe(2);
    expect(save).toHaveBeenCalledTimes(2);expect(await repo.pendingOperations()).toEqual([]);
  });
  it('never contacts the server to flush a read-only connection',async()=>{
    await repo.checkpoint(anchor);
    const transport=vi.fn();
    const result=await new SyncCoordinator(repo,new BookOrbitClient(session,{readOnly:true,fetch:transport})).flush();
    expect(result.readOnly).toBe(true); expect(transport).not.toHaveBeenCalled();
  });
  it('rejects a mismatched account before work begins',()=>{
    expect(()=>new SyncCoordinator(repo,new BookOrbitClient({...session,userId:'2'}))).toThrow('scopes');
  });
  it('preserves a newer server location instead of overwriting it with a stale retry',async()=>{
    await repo.checkpoint(anchor);
    const client=new BookOrbitClient(session);
    vi.spyOn(client,'getProgress').mockResolvedValue({...anchor,locator:'epubcfi(/6/8)',progress:0.1,updatedAt:'2026-10-09T11:00:00Z'});
    const save=vi.spyOn(client,'saveProgress').mockResolvedValue();
    const result=await new SyncCoordinator(repo,client).flush();
    expect(result.conflicts).toBe(1); expect(save).not.toHaveBeenCalled();
    expect((await repo.pendingOperations())[0].status).toBe('conflict');
  });
  it('allows intentional backward progress when the event is newer',async()=>{
    await repo.checkpoint(anchor);
    const client=new BookOrbitClient(session);
    vi.spyOn(client,'getProgress').mockResolvedValue({...anchor,locator:'epubcfi(/6/8)',progress:0.8,updatedAt:'2026-10-09T09:00:00Z'});
    const save=vi.spyOn(client,'saveProgress').mockResolvedValue();
    expect((await new SyncCoordinator(repo,client).flush()).sent).toBe(1);
    expect(save).toHaveBeenCalledWith(anchor); expect(await repo.pendingOperations()).toEqual([]);
  });
  it('does not duplicate an annotation after an uncertain network response',async()=>{
    const annotation:Annotation={id:crypto.randomUUID(),bookId:'4',fileId:'5',kind:'note',quote:'Text',text:'Note',color:'yellow',locator:'epubcfi(/6/2)',createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt};
    await repo.putAnnotation(annotation);
    const [op]=await repo.pendingOperations();
    await repo.updateOperation(op.id,{status:'uncertain'});
    const client=new BookOrbitClient(session);
    vi.spyOn(client,'getAnnotations').mockResolvedValue([{...annotation,id:'55'}]);
    const save=vi.spyOn(client,'saveAnnotation');
    expect((await new SyncCoordinator(repo,client).flush()).sent).toBe(1);
    expect(save).not.toHaveBeenCalled(); expect((await repo.getAnnotations())[0].id).toBe('55');
  });
  it('reconciles uncertain creates with no match as a conflict, never blind retry',async()=>{
    const annotation:Annotation={id:crypto.randomUUID(),bookId:'4',fileId:'5',kind:'note',quote:'Text',text:'Note',color:'yellow',locator:'epubcfi(/6/2)',createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt};
    await repo.putAnnotation(annotation); const [op]=await repo.pendingOperations(); await repo.updateOperation(op.id,{status:'uncertain'});
    const client=new BookOrbitClient(session);vi.spyOn(client,'getAnnotations').mockResolvedValue([]);
    const save=vi.spyOn(client,'saveAnnotation');
    expect((await new SyncCoordinator(repo,client).flush()).conflicts).toBe(1);expect(save).not.toHaveBeenCalled();
  });
  it('remaps a queued edit to its acknowledged server ID without creating a duplicate',async()=>{
    const first:Annotation={id:crypto.randomUUID(),bookId:'4',fileId:'5',kind:'note',quote:'Text',text:'First note',color:'yellow',locator:'epubcfi(/6/2)',createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt};
    const edited={...first,text:'Edited note',updatedAt:'2026-10-09T10:01:00Z'};
    await repo.putAnnotation(first); await repo.putAnnotation(edited);
    const client=new BookOrbitClient(session);
    let serverNote:Annotation|undefined;
    vi.spyOn(client,'getAnnotations').mockImplementation(async()=>serverNote?[serverNote]:[]);
    const save=vi.spyOn(client,'saveAnnotation').mockImplementation(async(note)=>{
      serverNote={...note,id:'55',updatedAt:'2026-10-09T11:00:00Z'};return serverNote;
    });
    const result=await new SyncCoordinator(repo,client).flush();
    expect(result.sent).toBe(2);expect(result.conflicts).toBe(0);
    expect(save.mock.calls[0][0].id).toBe(first.id);expect(save.mock.calls[1][0].id).toBe('55');
    expect((await repo.getAnnotations())[0]).toMatchObject({id:'55',text:'Edited note'});
  });
  it('retains audio metadata failures as explicit conflicts without retrying guessed progress',async()=>{
    await repo.checkpoint({...anchor,kind:'audio',locator:JSON.stringify({version:1,trackId:'5',trackTime:10,time:10})});
    const client=new BookOrbitClient(session);vi.spyOn(client,'getProgress').mockRejectedValue(new ProgressConflictError('Manifest changed'));
    const save=vi.spyOn(client,'saveProgress');
    expect((await new SyncCoordinator(repo,client).flush()).conflicts).toBe(1);expect(save).not.toHaveBeenCalled();
    expect((await repo.pendingOperations())[0].status).toBe('conflict');
  });
  it('retries uncertain audio creates with the same server-deduplicated UUID',async()=>{
    const note:Annotation={id:crypto.randomUUID(),bookId:'4',fileId:'5',kind:'audio',quote:'At 0:10',text:'Moment',color:'sand',locator:JSON.stringify({version:1,time:10}),createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt};
    await repo.putAnnotation(note);const [operation]=await repo.pendingOperations();await repo.updateOperation(operation.id,{status:'uncertain'});
    const client=new BookOrbitClient(session);vi.spyOn(client,'getAudioAnnotations').mockResolvedValue([]);const save=vi.spyOn(client,'saveAnnotation').mockResolvedValue(note);
    expect((await new SyncCoordinator(repo,client).flush()).sent).toBe(1);expect(save).toHaveBeenCalledWith(note);
  });
  it('shares in-flight work across coordinator instances for the same account',async()=>{
    await repo.checkpoint(anchor);const client=new BookOrbitClient(session);
    vi.spyOn(client,'getProgress').mockResolvedValue(null);const save=vi.spyOn(client,'saveProgress').mockResolvedValue();
    const first=new SyncCoordinator(repo,client),second=new SyncCoordinator(repo,client);
    const [a,b]=await Promise.all([first.flush(),second.flush()]);expect(a).toBe(b);expect(save).toHaveBeenCalledTimes(1);
  });
  it('does not steal a live IndexedDB mutation claim from another tab',async()=>{
    await repo.checkpoint(anchor);const [operation]=await repo.pendingOperations();expect(await repo.claimOperation(operation.id)).toBeDefined();
    const client=new BookOrbitClient(session),read=vi.spyOn(client,'getProgress');
    const result=await new SyncCoordinator(repo,client).flush();expect(result.sent).toBe(0);expect(read).not.toHaveBeenCalled();
    await repo.updateOperation(operation.id,{leaseUntil:'2000-01-01T00:00:00Z'});
    read.mockResolvedValue(anchor);expect((await new SyncCoordinator(repo,client).flush()).sent).toBe(1);
  });
});
