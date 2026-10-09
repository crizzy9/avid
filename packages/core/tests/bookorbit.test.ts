import {describe,it,expect,vi} from 'vitest';
import {BookOrbitClient,ContractError,ProgressConflictError,ReadOnlyError,normalizeServerUrl} from '../src/bookorbit';
import type {Annotation,ReadingAnchor,Session} from '../src/types';
const session:Session={profile:{id:'s',name:'Library',url:'https://books.example/base',username:'reader'},userId:'7',accessToken:'secret'};
const reply=(body:unknown,status=200)=>new Response(body===undefined?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const card={id:12,title:'A book',authors:['An Author'],files:[{id:31,format:'epub',role:'primary',sizeBytes:42}],genres:['Fiction'],readingProgress:27,readStatus:{status:'reading'},addedAt:'2026-10-01T00:00:00Z',hasCover:true};
const anchor:ReadingAnchor={bookId:'12',fileId:'31',kind:'epub',locator:'epubcfi(/6/2!/4/2:0)',progress:0.27,updatedAt:'2026-10-09T01:00:00Z'};
const manifest={schema:'bookorbit.audiobook-manifest',schemaVersion:2,revision:'a'.repeat(64),totalDurationMs:200000,assets:[{assetId:'aud_11111111-1111-4111-8111-111111111111',fileId:31,sequence:0,format:'mp3',durationMs:100000,sizeBytes:10,etag:'one'},{assetId:'aud_22222222-2222-4222-8222-222222222222',fileId:32,sequence:1,format:'mp3',durationMs:100000,sizeBytes:10,etag:'two'}],chapters:[{id:'ch1',title:'First',assetId:'aud_11111111-1111-4111-8111-111111111111',sequence:0,startMs:0,endMs:100000,assetOffsetMs:0},{id:'ch2',title:'Second',assetId:'aud_22222222-2222-4222-8222-222222222222',sequence:1,startMs:100000,endMs:200000,assetOffsetMs:0}]};
describe('BookOrbit v3.3.0 contract adapter',()=>{
  it('translates one-based catalog pagination for collection and scope reads',async()=>{
    const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>reply({items:[card],total:150,page:1,size:48}));
    const client=new BookOrbitClient(session,{fetch:transport,readOnly:true});
    expect((await client.getCollectionBooks('9',2,48)).page).toBe(2);
    expect(transport.mock.calls[0][0]).toContain('/collections/9/books?page=1&size=48');
    await client.getCollectionBooks('9',2,48,{media:'audio'});
    expect(JSON.parse(String(transport.mock.calls[1][1]?.body)).pagination).toEqual({page:1,size:48});
    await client.getSmartScopeBooks('9',2,48);
    expect(transport.mock.calls[2][0]).toContain('/smart-scopes/9/books?page=1&size=48');
    await expect(client.listBooks({page:0})).rejects.toThrow('Page numbers start at one.');
  });
  it('reads selected-book membership for owned collection picker targets without loading books',async()=>{
    const transport=vi.fn().mockResolvedValue(reply([{id:9,name:'Current',mediaType:'books',memberCount:1},{id:10,name:'Later',mediaType:'books',memberCount:0}]));
    const client=new BookOrbitClient(session,{fetch:transport,readOnly:true});
    expect(await client.getBookCollections('12')).toEqual([{id:'9',name:'Current',bookIds:['12']},{id:'10',name:'Later',bookIds:[]}]);
    expect(transport.mock.calls[0][0]).toContain('/collections?bookIds=12');
    expect(transport.mock.calls[0][1].method).toBeUndefined();
  });
  it('preserves deployment paths and rejects embedded credentials',()=>{
    expect(normalizeServerUrl('https://books.example/base/api/v1/')).toBe('https://books.example/base');
    expect(()=>normalizeServerUrl('https://reader:password@books.example')).toThrow(ContractError);
  });
  it('authenticates through a proxy without changing account identity',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({accessToken:'access',user:{id:7,username:'reader'}}));
    const result=await BookOrbitClient.login(session.profile,'password',{fetch:transport,transportBaseUrl:'/bookorbit'});
    expect(result.profile.url).toBe(session.profile.url);
    expect(transport.mock.calls[0][0]).toBe('/bookorbit/api/v1/auth/login');
    expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({username:'reader',password:'password',clientKind:'web'});
  });
  it('uses the verified read-only query route and converts percent units',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({items:[card],total:1,page:0,size:100}));
    const client=new BookOrbitClient(session,{fetch:transport,readOnly:true});
    const books=await client.listBooks();
    expect(books.items[0]).toMatchObject({id:'12',progress:0.27,format:'EPUB',status:'reading',files:[{id:'31',format:'EPUB'}]});
    expect(transport.mock.calls[0][0]).toBe('https://books.example/base/api/v1/books/query');
    expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({pagination:{page:0,size:100}});
    expect(books.page).toBe(1);
    expect(client.fileUrl('31')).not.toContain('secret');
  });
  it('blocks mutations before issuing any network request in read-only mode',async()=>{
    const transport=vi.fn(); const client=new BookOrbitClient(session,{fetch:transport,readOnly:true});
    await expect(client.saveProgress(anchor)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(client.setStatus('12','finished')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(client.patchPreferences('31',{fontSize:24})).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(client.createAudioBookmark('12',{clientId:crypto.randomUUID(),positionMs:100,title:'Note'})).rejects.toBeInstanceOf(ReadOnlyError);
    expect(transport).not.toHaveBeenCalled();
  });
  it('sends exact locator and percent with no invented source-timestamp field',async()=>{
    const transport=vi.fn().mockResolvedValue(reply(undefined,204));
    await new BookOrbitClient(session,{fetch:transport}).saveProgress(anchor);
    expect(transport.mock.calls[0][0]).toContain('/books/files/31/progress');
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({percentage:27,cfi:anchor.locator});
  });
  it('rejects malformed catalog responses instead of pretending an empty library',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({items:[{id:'invalid'}],total:1,page:1,size:100}));
    await expect(new BookOrbitClient(session,{fetch:transport}).listBooks()).rejects.toThrow(ContractError);
  });
  it('refreshes once for concurrent expired-token requests',async()=>{
    const transport=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith('/auth/refresh')) return reply({accessToken:'fresh'});
      if(new Headers(init?.headers).get('Authorization')==='Bearer secret') return reply({message:'Expired'},401);
      return reply({version:'v3.3.0',features:[]});
    });
    const client=new BookOrbitClient(session,{fetch:transport});
    await Promise.all([client.getServerInfo(),client.getServerInfo()]);
    expect(transport.mock.calls.filter(c=>String(c[0]).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(client.session.accessToken).toBe('fresh');
  });
  it('keeps reading-session identity and activity units stable on retries',async()=>{
    const transport=vi.fn().mockResolvedValue(reply(undefined,204));
    await new BookOrbitClient(session,{fetch:transport}).saveReadingSession({id:'operation-1',bookId:'12',kind:'listening',startedAt:'2026-10-09T00:00:00Z',duration:60},'31',{endProgress:0.25});
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({sessionId:'operation-1',startedAt:'2026-10-09T00:00:00Z',endedAt:'2026-10-09T00:01:00.000Z',durationSeconds:60,sessionType:'listen',endProgress:25});
  });
  it('maps null genres without inventing progress when only a reading status exists',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({items:[{...card,genres:null,readingProgress:null}],total:1,page:1,size:100}));
    const [book]=(await new BookOrbitClient(session,{fetch:transport}).listBooks()).items;
    expect(book.genres).toEqual([]);expect(book.status).toBe('reading');expect(book.progress).toBe(0);
  });
  it('builds streaming tracks and source-time chapters from the manifest without media downloads',async()=>{
    const transport=vi.fn().mockResolvedValue(reply(manifest));const client=new BookOrbitClient(session,{fetch:transport,transportBaseUrl:'/bookorbit'});
    const source=await client.getPlaybackSource({id:'12',title:'Audio',authors:['Author'],format:'AUDIO',description:'',color:'red',progress:0,status:'unread',genres:[],addedAt:anchor.updatedAt,files:[{id:'31',name:'One',format:'AUDIO'}]});
    expect(source.tracks.map(track=>({id:track.id,duration:track.duration}))).toEqual([{id:'31',duration:100},{id:'32',duration:100}]);
    expect(source.tracks[1].url).toBe(`/bookorbit/api/v1/audiobooks/12/assets/${manifest.assets[1].assetId}/content`);
    expect(source.chapters[1]).toMatchObject({start:100,duration:100});expect(transport).toHaveBeenCalledTimes(1);
  });
  it('saves track-relative JSON audio checkpoints using guarded revisions and the original source time',async()=>{
    const state={assetId:manifest.assets[0].assetId,positionMs:1000,percentage:0.5,completed:false,capturedAt:'2026-10-09T00:00:00Z',revision:4,manifestRevision:manifest.revision};
    const transport=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(String(input).endsWith('/manifest'))return reply(manifest);
      if(init?.method==='PUT')return reply({...state,...JSON.parse(String(init.body)),revision:5,percentage:65});
      return reply(state);
    });
    const client=new BookOrbitClient(session,{fetch:transport});const operationId=crypto.randomUUID();
    await client.saveProgress({...anchor,kind:'audio',locator:JSON.stringify({version:1,trackId:'32',trackTime:30,time:130}),progress:0.65},{operationId});
    const writes=transport.mock.calls.filter(call=>call[1]?.method==='PUT');
    expect(writes).toHaveLength(1);expect(String(writes[0][0])).toContain('/audiobooks/12/playback-state');
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({assetId:manifest.assets[1].assetId,positionMs:30000,capturedAt:anchor.updatedAt,operationId,baseRevision:4,manifestRevision:manifest.revision});
    expect(transport.mock.calls.some(call=>String(call[0]).includes('/audio-progress'))).toBe(false);
  });
  it('refuses mismatched audio timelines without writing a guessed position',async()=>{
    const transport=vi.fn(async(input:RequestInfo|URL)=>reply(String(input).endsWith('/manifest')?manifest:null));
    const client=new BookOrbitClient(session,{fetch:transport});
    await expect(client.saveProgress({...anchor,kind:'audio',locator:JSON.stringify({version:1,trackId:'32',trackTime:30,time:30})})).rejects.toBeInstanceOf(ProgressConflictError);
    expect(transport.mock.calls).toHaveLength(2);
  });
  it('routes generic audio notes through the UUID-deduplicated bookmark endpoint in source milliseconds',async()=>{
    const id=crypto.randomUUID();const note:Annotation={id,bookId:'12',fileId:'31',kind:'audio',quote:'At 2:10',text:'Listen again',color:'sand',locator:JSON.stringify({version:1,trackId:'32',trackTime:30.125,time:130.125}),createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt};
    const transport=vi.fn().mockResolvedValueOnce(reply([])).mockResolvedValueOnce(reply({id,bookId:12,positionMs:130125,chapterId:null,title:'At 2:10',note:'Listen again',createdAt:anchor.updatedAt,updatedAt:anchor.updatedAt}));
    const saved=await new BookOrbitClient(session,{fetch:transport}).saveAnnotation(note);
    expect(transport.mock.calls[1][0]).toContain('/audiobooks/12/bookmarks');
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({clientId:id,positionMs:130125,title:'At 2:10',note:'Listen again'});
    expect(saved.kind).toBe('audio');expect(JSON.parse(saved.locator).time).toBe(130.125);
  });
  it('preserves actual end time, active duration, source and signed progress delta in session writes',async()=>{
    const transport=vi.fn().mockResolvedValue(reply(undefined,204));const client=new BookOrbitClient(session,{fetch:transport});
    await client.saveReadingSession({id:'immutable-chunk-1',bookId:'12',kind:'speech',startedAt:'2026-10-09T00:00:00Z',duration:60.9},'31',{endedAt:'2026-10-09T00:05:00Z',endProgress:0.3,progressDelta:-0.2,source:'ios'});
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({sessionId:'immutable-chunk-1',startedAt:'2026-10-09T00:00:00Z',endedAt:'2026-10-09T00:05:00Z',durationSeconds:60,sessionType:'tts',source:'ios',endProgress:30,progressDelta:-20});
    await expect(client.saveReadingSession({id:'x',bookId:'12',kind:'reading',startedAt:anchor.updatedAt,duration:Infinity},'31')).rejects.toThrow(ContractError);
  });
  it('preserves the exact server reading status while keeping display group compatibility',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({items:[{...card,readStatus:{status:'want_to_read'}}],total:1,page:1,size:100}));
    expect((await new BookOrbitClient(session,{fetch:transport}).listBooks()).items[0]).toMatchObject({status:'unread',serverStatus:'want_to_read'});
  });
  it('applies format and reading-status filters on the server before pagination and retains companion audio',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({items:[{...card,files:[...card.files,{id:32,format:'m4b',role:'supplemental',sizeBytes:100}]}],total:1,page:2,size:48}));
    const page=await new BookOrbitClient(session,{fetch:transport,readOnly:true}).listBooks({page:2,size:48,media:'audio',query:'book',readStatuses:['reading','want_to_read']});
    const body=JSON.parse(transport.mock.calls[0][1].body);
    expect(body.filter).toEqual({type:'group',join:'AND',rules:[{type:'rule',field:'format',operator:'includesAny',value:['m4b','mp3','m4a','opus','ogg','flac']},{type:'rule',field:'readStatus',operator:'includesAny',value:['reading','want_to_read']}]});
    expect(body.pagination).toEqual({page:1,size:48});expect(page.items[0].files[1]).toMatchObject({id:'32',format:'AUDIO'});
  });
  it('writes explicit collection membership IDs and private creation settings to verified routes',async()=>{
    const transport=vi.fn().mockImplementation(async()=>reply({id:9,name:'Favorites',mediaType:'books'}));
    const client=new BookOrbitClient(session,{fetch:transport});
    expect(await client.createCollection({name:' Favorites '})).toEqual({id:'9',name:'Favorites',bookIds:[]});
    await client.addCollectionBooks('9',['12','13','12']);await client.removeCollectionBooks('9',['13']);
    expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({name:'Favorites',mediaType:'books',isPublic:false,syncToKobo:false});
    expect(transport.mock.calls[1][0]).toContain('/collections/9/books');expect(transport.mock.calls[1][1].method).toBe('POST');expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({bookIds:[12,13]});
    expect(transport.mock.calls[2][1].method).toBe('DELETE');expect(JSON.parse(transport.mock.calls[2][1].body)).toEqual({bookIds:[13]});
  });
  it('blocks raw status and collection writes at the read-only boundary',async()=>{
    const transport=vi.fn();const client=new BookOrbitClient(session,{fetch:transport,readOnly:true});
    await expect(client.setReadStatus('12','abandoned')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(client.createCollection({name:'Shelf'})).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(client.addCollectionBooks('9',['12'])).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(client.removeCollectionBooks('9',['12'])).rejects.toBeInstanceOf(ReadOnlyError);
    expect(transport).not.toHaveBeenCalled();
  });
  it('reads server statistics with seconds and server timezone unchanged',async()=>{
    const duration={totalSeconds:900,readingSeconds:600,listeningSeconds:300};
    const overview={generatedAt:anchor.updatedAt,timezone:'America/New_York',snapshot:{today:duration,lastSevenDays:duration,previousSevenDays:duration,currentStreak:4,longestStreak:8,completedBooksYtd:6},calendar:{year:2026,availableYears:[2025,2026],days:[{...duration,day:'2026-10-09',sessionsCount:3,bySource:{ios:900}}]},sources:{windowDays:365,totals:duration,slices:[{bucket:'ios',totalSeconds:900}]}};
    const summary={trackedBooks:40,startedBooks:12,inProgressBooks:6,completedBooks:6,meanProgressPercent:32};
    const transport=vi.fn(async(input:RequestInfo|URL)=>reply(String(input).endsWith('/summary')?summary:overview));
    const stats=await new BookOrbitClient(session,{fetch:transport,readOnly:true}).getReadingStatistics();
    expect(stats.snapshot.currentStreak).toBe(4);expect(stats.calendar.days[0].listeningSeconds).toBe(300);expect(stats.summary.meanProgressPercent).toBe(32);expect(stats.timezone).toBe('America/New_York');
    expect(transport.mock.calls.map(call=>String(call[0]))).toEqual(['https://books.example/base/api/v1/user-statistics/activity-overview','https://books.example/base/api/v1/user-statistics/summary']);
  });
  it('uses paginated server book-session reads with source activity type',async()=>{
    const transport=vi.fn().mockResolvedValue(reply({items:[{id:9,bookFileId:31,startedAt:anchor.updatedAt,endedAt:anchor.updatedAt,durationSeconds:45,progressDelta:-2,endProgress:20,format:'epub',source:'ios',sessionType:'tts'}],total:1,page:1,pageSize:25,stats:{totalSessions:1,totalSeconds:45,avgDurationSeconds:45,firstSessionAt:anchor.updatedAt,lastSessionAt:anchor.updatedAt,dailySummary:[{day:'2026-10-09',totalMinutes:0.75}]}}));
    const sessions=await new BookOrbitClient(session,{fetch:transport,readOnly:true}).getBookSessions('12');
    expect(sessions.items[0]).toMatchObject({id:'9',bookFileId:'31',sessionType:'tts',progressDelta:-2,durationSeconds:45});
    expect(transport.mock.calls[0][0]).toContain('/books/12/sessions?page=1&pageSize=25&sortBy=startedAt&sortDir=desc');
  });
  it('exposes the documented OIDC transport without fabricating a native callback capability',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(reply({state:'opaque-state',authorizationEndpoint:'https://idp.example/authorize'})).mockResolvedValueOnce(reply({mode:'login',accessToken:'access',user:{id:7,username:'reader'}}));
    expect(await BookOrbitClient.createOidcState(session.profile.url,'authentik',{fetch:transport,transportBaseUrl:'/bookorbit'})).toEqual({state:'opaque-state',authorizationEndpoint:'https://idp.example/authorize'});
    const callback={code:'code',state:'opaque-state',codeVerifier:'proof-key',nonce:'nonce',redirectUri:'https://books.example/oauth2-callback'};
    await BookOrbitClient.exchangeOidcCode(session.profile,callback,{fetch:transport});
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({...callback,clientKind:'web',deviceLabel:'Avid'});
  });
});
