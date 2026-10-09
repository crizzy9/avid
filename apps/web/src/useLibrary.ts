import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOrbitClient } from '../../../packages/core/src/bookorbit';
import { AvidDatabase, LibraryRepository } from '../../../packages/core/src/repository';
import { SyncCoordinator } from '../../../packages/core/src/sync';
import type { Annotation, Book, Collection, ReadingAnchor, ReadingSession, Session } from '../../../packages/core/src/types';
import { demoBooks, demoCollections } from './fixtures';
import { bookOrbitFetch, proxyBaseFor } from './Connect';

const db=new AvidDatabase();
const demoSession:Session={profile:{id:'demo',name:'Sample library',url:'https://demo.avid.invalid'},accessToken:'',userId:'demo'};

export function useLibrary() {
  const [client,setClient]=useState<BookOrbitClient|null>(null);
  const [repo,setRepo]=useState(()=>new LibraryRepository(db,demoSession));
  const [books,setBooks]=useState<Book[]>(demoBooks);const [collections,setCollections]=useState<Collection[]>(demoCollections);
  const [annotations,setAnnotations]=useState<Annotation[]>([]);const [sessions,setSessions]=useState<ReadingSession[]>([]);
  const [loading,setLoading]=useState(false);const [error,setError]=useState('');const [total,setTotal]=useState(demoBooks.length);
  const [syncStatus,setSyncStatus]=useState('On this device');const objectUrls=useRef(new Set<string>());
  const accountEpoch=useRef(0);
  const coordinator=useMemo(()=>client?new SyncCoordinator(repo,client):null,[repo,client]);

  useEffect(()=>{let active=true;Promise.all([repo.getBooks(),repo.getAnnotations(),repo.getSessions(),repo.getCollections()]).then(async([saved,notes,activity,shelves])=>{if(!active)return;if(!client){if(!saved.length)await repo.putBooks(demoBooks);if(!shelves.length)await repo.putCollections(demoCollections);if(!active)return;setBooks(saved.length?saved:demoBooks);setCollections(shelves.length?shelves:demoCollections);setTotal(saved.length||demoBooks.length);}setAnnotations(notes);setSessions(activity);}).catch(e=>setError(`Local storage is unavailable: ${e.message}`));return()=>{active=false;};},[repo,client]);
  useEffect(()=>()=>{for(const url of objectUrls.current)URL.revokeObjectURL(url);},[]);

  const loadCovers=useCallback(async(items:Book[],activeClient:BookOrbitClient,epoch:number)=>{
    // Bounded batches keep initial browsing responsive and isolate authenticated media.
    for(let offset=0;offset<items.length;offset+=6){if(accountEpoch.current!==epoch)return;
      await Promise.allSettled(items.slice(offset,offset+6).map(async book=>{if(!book.coverUrl)return;const blob=await activeClient.coverBlob(book.id);if(accountEpoch.current!==epoch)return;const url=URL.createObjectURL(blob);objectUrls.current.add(url);setBooks(previous=>previous.map(b=>b.id===book.id?{...b,coverUrl:url}:b));}));
    }
  },[]);

  const connect=useCallback(async(session:Session,readOnly:boolean)=>{
    const nextClient=new BookOrbitClient(session,{readOnly,fetch:bookOrbitFetch,transportBaseUrl:proxyBaseFor(session.profile.url)});
    const [page,shelves]=await Promise.all([nextClient.listBooks({size:48}),nextClient.listCollections()]);
    try{const info=await nextClient.getServerInfo();nextClient.session={...session,profile:{...session.profile,version:info.version}};}catch{/* Version discovery can be unavailable on older servers. */}
    accountEpoch.current++;const epoch=accountEpoch.current;
    const nextRepo=new LibraryRepository(db,session);
    await nextRepo.putBooks(page.items);await nextRepo.putCollections(shelves);
    setClient(nextClient);setRepo(nextRepo);setBooks(page.items.map(b=>({...b,coverUrl:undefined})));setCollections(shelves);setTotal(page.total);setError('');
    setSyncStatus(readOnly?'Read-only server':'Connected');void loadCovers(page.items,nextClient,epoch);
  },[loadCovers]);

  const disconnect=useCallback(()=>{accountEpoch.current++;setClient(null);setRepo(new LibraryRepository(db,demoSession));setBooks(demoBooks);setAnnotations([]);setSessions([]);setCollections(demoCollections);setTotal(demoBooks.length);setSyncStatus('On this device');setError('');for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();},[]);

  const query=useCallback(async(options:{query?:string;sort?:'title'|'addedAt'|'lastReadAt';direction?:'asc'|'desc';page?:number;collectionId?:string},signal?:AbortSignal)=>{
    if(!client)return;setLoading(true);setError('');const epoch=accountEpoch.current;
    try{const page=options.collectionId?await client.getCollectionBooks(options.collectionId,options.page??1,48):await client.listBooks({...options,size:48},signal);
      if(accountEpoch.current!==epoch||signal?.aborted)return;
      setBooks(previous=>options.page&&options.page>1?[...previous,...page.items.map(b=>({...b,coverUrl:undefined}))]:page.items.map(b=>({...b,coverUrl:undefined})));setTotal(page.total);await repo.putBooks(page.items);void loadCovers(page.items,client,epoch);
    }catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'Could not load the library.');}finally{if(!signal?.aborted)setLoading(false);}
  },[client,repo,loadCovers]);

  const flush=useCallback(async()=>{if(!client||client.readOnly||!coordinator)return;setSyncStatus('Syncing…');const result=await coordinator.flush();setSyncStatus(result.conflicts?'Needs review':result.failed?'Sync failed':'Synced');},[client,coordinator]);
  const saveAnchor=useCallback(async(anchor:ReadingAnchor)=>{try{await repo.checkpoint(anchor,{readOnly:!client||client.readOnly});const saved=await repo.getBook(anchor.bookId);if(saved)await repo.putBooks([{...saved,progress:anchor.progress,status:anchor.progress>=.995?'finished':'reading'}]);setBooks(previous=>previous.map(book=>book.id===anchor.bookId?{...book,progress:anchor.progress,status:anchor.progress>=.995?'finished':'reading'}:book));await flush();}catch(e){setError(e instanceof Error?e.message:'Position could not be saved.');}},[repo,client,flush]);
  const saveAnnotation=useCallback(async(annotation:Annotation)=>{await repo.putAnnotation(annotation,{readOnly:!client||client.readOnly});setAnnotations(await repo.getAnnotations());await flush();},[repo,client,flush]);
  const recordSession=useCallback(async(activity:ReadingSession,fileId:string)=>{await repo.recordSession(activity,fileId,{readOnly:!client||client.readOnly});setSessions(await repo.getSessions());await flush();},[repo,client,flush]);
  const updateDemoBook=useCallback(async(book:Book)=>{if(client)return;await repo.putBooks([book]);setBooks(previous=>previous.map(b=>b.id===book.id?book:b));},[repo,client]);
  const saveCollections=useCallback(async(next:Collection[])=>{if(client)return;await repo.putCollections(next);setCollections(next);},[repo,client]);
  const refreshAnnotations=useCallback(async()=>setAnnotations(await repo.getAnnotations()),[repo]);
  return {client,repo,books,setBooks,collections,annotations,sessions,loading,error,setError,total,syncStatus,connect,disconnect,query,saveAnchor,saveAnnotation,recordSession,updateDemoBook,saveCollections,refreshAnnotations};
}
