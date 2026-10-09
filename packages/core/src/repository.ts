import Dexie, { type Table } from 'dexie';
import type { Annotation, Book, Collection, ReadingAnchor, ReadingSession, Session } from './types';
import { normalizeServerUrl } from './bookorbit';

/** Server URL and authenticated identity, never a token or a display/profile name. */
export function accountScope(session: Pick<Session,'profile'|'userId'>): string {
  return JSON.stringify([normalizeServerUrl(session.profile.url),session.userId]);
}
export type OutboxStatus='pending'|'syncing'|'conflict'|'failed'|'uncertain';
export type SyncPayload =
  | {kind:'progress';anchor:ReadingAnchor}
  | {kind:'annotation';annotation:Annotation}
  | {kind:'session';session:ReadingSession;fileId:string;endedAt:string};
export interface OutboxOperation {
  key:string; scope:string; id:string; entityKey:string; payload:SyncPayload; occurredAt:string;
  status:OutboxStatus; attempts:number; error?:string; nextAttemptAt?:string;
  expectedRemoteUpdatedAt?:string;
  leaseUntil?:string;
}
interface RecordRow<T> { key:string; scope:string; id:string; value:T; }
export class AvidDatabase extends Dexie {
  books!:Table<RecordRow<Book>,string>;
  anchors!:Table<RecordRow<ReadingAnchor>,string>;
  annotations!:Table<RecordRow<Annotation>,string>;
  collections!:Table<RecordRow<Collection>,string>;
  sessions!:Table<RecordRow<ReadingSession>&{fileId?:string;endedAt?:string},string>;
  preferences!:Table<RecordRow<Record<string,unknown>>,string>;
  outbox!:Table<OutboxOperation,string>;
  constructor(name='avid-library-v1') {
    super(name);
    this.version(1).stores({books:'key,scope,[scope+id]',anchors:'key,scope,[scope+id]',annotations:'key,scope,[scope+id]',collections:'key,scope,[scope+id]',sessions:'key,scope,[scope+id]',preferences:'key,scope,[scope+id]',outbox:'key,scope,[scope+entityKey],[scope+status]'});
  }
}
export const anchorIdentity=(anchor:Pick<ReadingAnchor,'bookId'|'fileId'|'kind'>)=>JSON.stringify([anchor.bookId,anchor.fileId,anchor.kind]);
function requireTime(value:string):void { if (!Number.isFinite(Date.parse(value))) throw new Error('A source event timestamp is required.'); }
/** Each instance is permanently scoped; changing accounts creates a new instance. */
export class LibraryRepository {
  readonly scope:string;
  constructor(public readonly db:AvidDatabase,session:Pick<Session,'profile'|'userId'>) { this.scope=accountScope(session); }
  private key(id:string):string { return JSON.stringify([this.scope,id]); }
  private row<T>(id:string,value:T):RecordRow<T> { return {key:this.key(id),scope:this.scope,id,value}; }
  async putBooks(books:Book[]):Promise<void> {
    // Object URLs belong to one document lifetime, never a durable metadata cache.
    await this.db.books.bulkPut(books.map(book=>this.row(book.id,{...book,coverUrl:book.coverUrl?.startsWith('blob:')?undefined:book.coverUrl})));
  }
  async getBooks():Promise<Book[]> { return (await this.db.books.where('scope').equals(this.scope).toArray()).map(row=>row.value); }
  async getBook(id:string):Promise<Book|undefined> { return (await this.db.books.get(this.key(id)))?.value; }
  async putCollections(collections:Collection[]):Promise<void> { await this.db.collections.bulkPut(collections.map(c=>this.row(c.id,c))); }
  async getCollections():Promise<Collection[]> { return (await this.db.collections.where('scope').equals(this.scope).toArray()).map(row=>row.value); }
  async getAnchor(identity:Pick<ReadingAnchor,'bookId'|'fileId'|'kind'>):Promise<ReadingAnchor|undefined> { return (await this.db.anchors.get(this.key(anchorIdentity(identity))))?.value; }
  async getAnchors():Promise<ReadingAnchor[]> { return (await this.db.anchors.where('scope').equals(this.scope).toArray()).map(row=>row.value); }
  /** Atomic local checkpoint + durable intent. readOnly prevents ever creating server work. */
  async checkpoint(anchor:ReadingAnchor,options:{readOnly?:boolean}={}):Promise<void> {
    requireTime(anchor.updatedAt);
    const id=anchorIdentity(anchor);
    await this.db.transaction('rw',[this.db.anchors,this.db.outbox,this.db.books],async()=>{
      const existing=await this.db.anchors.get(this.key(id));
      if (existing && Date.parse(existing.value.updatedAt)>Date.parse(anchor.updatedAt)) return;
      await this.db.anchors.put(this.row(id,anchor));
      const book=await this.db.books.get(this.key(anchor.bookId));
      if(book)await this.db.books.put({...book,value:{...book.value,progress:anchor.progress,status:anchor.progress>=.995?'finished':'reading'}});
      if (!options.readOnly) await this.enqueue(`progress:${id}`,{kind:'progress',anchor},anchor.updatedAt,true);
    });
  }
  async importAnchor(anchor:ReadingAnchor):Promise<void> {
    requireTime(anchor.updatedAt);
    await this.db.transaction('rw',this.db.anchors,async()=>{
      const current=await this.db.anchors.get(this.key(anchorIdentity(anchor)));
      if(current&&Date.parse(current.value.updatedAt)>=Date.parse(anchor.updatedAt))return;
      await this.db.anchors.put(this.row(anchorIdentity(anchor),anchor));
    });
  }
  async getAnnotations(bookId?:string,includeDeleted=false):Promise<Annotation[]> {
    return (await this.db.annotations.where('scope').equals(this.scope).toArray()).map(row=>row.value).filter(a=>(!bookId||a.bookId===bookId)&&(includeDeleted||!a.deleted));
  }
  async putAnnotation(annotation:Annotation,options:{readOnly?:boolean}={}):Promise<void> {
    requireTime(annotation.updatedAt);
    await this.db.transaction('rw',[this.db.annotations,this.db.outbox],async()=>{
      await this.db.annotations.put(this.row(annotation.id,annotation));
      if (!options.readOnly) await this.enqueue(`annotation:${annotation.id}`,{kind:'annotation',annotation},annotation.updatedAt,false);
    });
  }
  async importAnnotations(annotations:Annotation[]):Promise<void> {
    await this.db.transaction('rw',this.db.annotations,this.db.outbox,async()=>{
      for(const annotation of annotations) {
        const pending=await this.db.outbox.where('[scope+entityKey]').equals([this.scope,`annotation:${annotation.id}`]).count();
        const current=await this.db.annotations.get(this.key(annotation.id));
        const newerLocal=current&&Date.parse(current.value.updatedAt)>=Date.parse(annotation.updatedAt);
        if (!pending && !current?.value.deleted && !newerLocal) await this.db.annotations.put(this.row(annotation.id,annotation));
      }
    });
  }
  async acknowledgeAnnotation(localId:string,remote:Annotation):Promise<void> {
    await this.db.transaction('rw',this.db.annotations,this.db.outbox,async()=>{
      const queued=await this.db.outbox.where('[scope+entityKey]').equals([this.scope,`annotation:${localId}`]).toArray();
      const newer=queued.filter(o=>o.status==='pending'&&o.payload.kind==='annotation').sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt))[0];
      const localValue=newer?.payload.kind==='annotation'?{...newer.payload.annotation,id:remote.id}:remote;
      if(localId!==remote.id) await this.db.annotations.delete(this.key(localId));
      await this.db.annotations.put(this.row(remote.id,localValue));
      for(const operation of queued) if(operation.payload.kind==='annotation') await this.db.outbox.update(operation.key,{entityKey:`annotation:${remote.id}`,expectedRemoteUpdatedAt:remote.updatedAt,payload:{kind:'annotation',annotation:{...operation.payload.annotation,id:remote.id}}});
    });
  }
  async recordSession(session:ReadingSession,fileId:string,options:{readOnly?:boolean;endedAt?:string}={}):Promise<void> {
    requireTime(session.startedAt);
    if(!Number.isFinite(session.duration)||session.duration<0) throw new Error('Active session duration must be finite and nonnegative.');
    const endedAt=options.endedAt??new Date().toISOString();
    requireTime(endedAt);
    if(Date.parse(endedAt)<Date.parse(session.startedAt)) throw new Error('Session end must follow its start.');
    await this.db.transaction('rw',[this.db.sessions,this.db.outbox],async()=>{
      const existing=await this.db.sessions.get(this.key(session.id));
      if(existing) {
        const same=existing.value.bookId===session.bookId&&existing.value.kind===session.kind&&existing.value.startedAt===session.startedAt&&existing.value.duration===session.duration&&(!existing.fileId||existing.fileId===fileId)&&(!options.endedAt||!existing.endedAt||existing.endedAt===options.endedAt);
        if(same) return;
        throw new Error('This session ID already belongs to a different immutable activity record.');
      }
      await this.db.sessions.put({...this.row(session.id,session),fileId,endedAt});
      if (!options.readOnly) await this.enqueue(`session:${session.id}`,{kind:'session',session,fileId,endedAt},endedAt,true);
    });
  }
  async getSessions():Promise<ReadingSession[]> { return (await this.db.sessions.where('scope').equals(this.scope).toArray()).map(row=>row.value); }
  async getPreferences(id='reader'):Promise<Record<string,unknown>> { return (await this.db.preferences.get(this.key(id)))?.value??{}; }
  async patchPreferences(set:Record<string,unknown>,id='reader'):Promise<void> {
    await this.db.transaction('rw',this.db.preferences,async()=>{await this.db.preferences.put(this.row(id,{...await this.getPreferences(id),...set}));});
  }
  private async enqueue(entityKey:string,payload:SyncPayload,occurredAt:string,coalesce:boolean):Promise<void> {
    // Never rewrite an in-flight operation; it may already be acknowledged by the server.
    if(coalesce) {
      const obsolete=await this.db.outbox.where('[scope+entityKey]').equals([this.scope,entityKey]).filter(o=>o.status==='pending').primaryKeys();
      await this.db.outbox.bulkDelete(obsolete);
    }
    const id=crypto.randomUUID();
    await this.db.outbox.put({key:this.key(id),scope:this.scope,id,entityKey,payload,occurredAt,status:'pending',attempts:0});
  }
  async pendingOperations():Promise<OutboxOperation[]> { return (await this.db.outbox.where('scope').equals(this.scope).toArray()).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)); }
  async getOperation(id:string):Promise<OutboxOperation|undefined> { return this.db.outbox.get(this.key(id)); }
  /** IndexedDB transaction serializes claims across tabs; expired claims use uncertain-write recovery. */
  async claimOperation(id:string):Promise<OutboxOperation|undefined> {
    return this.db.transaction('rw',this.db.outbox,async()=>{
      const current=await this.getOperation(id),now=Date.now();
      if(!current||['failed','conflict'].includes(current.status))return undefined;
      if(current.nextAttemptAt&&Date.parse(current.nextAttemptAt)>now)return undefined;
      if(current.status==='syncing'&&current.leaseUntil&&Date.parse(current.leaseUntil)>now)return undefined;
      await this.db.outbox.update(current.key,{status:'syncing',attempts:current.attempts+1,leaseUntil:new Date(now+60000).toISOString()});
      return current;
    });
  }
  async updateOperation(id:string,patch:Partial<Pick<OutboxOperation,'status'|'attempts'|'error'|'nextAttemptAt'|'leaseUntil'>>):Promise<void> { await this.db.outbox.update(this.key(id),patch); }
  async acknowledge(id:string):Promise<void> { await this.db.outbox.delete(this.key(id)); }
  async clearAccount():Promise<void> {
    const tables=[this.db.books,this.db.anchors,this.db.annotations,this.db.collections,this.db.sessions,this.db.preferences,this.db.outbox];
    await this.db.transaction('rw',tables,async()=>{for(const table of tables) await table.where('scope').equals(this.scope).delete();});
  }
}
