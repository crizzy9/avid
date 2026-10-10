import { z } from 'zod';
import type { Annotation, Book, BookFile, BookOrbitReadStatus, Collection, ReadingAnchor, ReadingSession, ServerProfile, Session } from './types';
import { bookOrbitTextProgress, koreaderRestoreAnchor, parseKoreaderCheckpoint, KoreaderContractError, type KoreaderCheckpoint, type KoreaderFileIdentity } from './koreader';
import { mediaOverlayPath, mediaOverlayPlaylistSchema, type MediaOverlayPlaylist } from './media-overlay';
import { boundedBlob } from './boundedBlob';

/** Contract inspected at BookOrbit v3.3.0 / e767358443419253eeed782518d6fc4f675d69fd. */
export const BOOKORBIT_CONTRACT_VERSION = '3.3.0';
export class BookOrbitError extends Error {
  constructor(message: string, public readonly status: number, public readonly detail?: unknown) { super(message); this.name = 'BookOrbitError'; }
}
export class ReadOnlyError extends BookOrbitError {
  constructor() { super('This server connection is read-only. Changes are saved on this device only.', 403); this.name = 'ReadOnlyError'; }
}
export class ContractError extends Error { constructor(message: string) { super(message); this.name = 'ContractError'; } }
export class ProgressConflictError extends ContractError { constructor(message:string) { super(message); this.name='ProgressConflictError'; } }
export interface ClientOptions {
  readOnly?: boolean;
  /** Same-origin proxy base, e.g. /bookorbit. Account identity remains profile.url. */
  transportBaseUrl?: string;
  fetch?: typeof fetch;
  clientKind?: 'web' | 'native';
  /** Native hosts coordinate refresh with background playback and durable credential storage. */
  refreshSession?: (session: Session) => Promise<Session>;
  onSessionChange?: (session: Session) => void | Promise<void>;
}
const numericId = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String);
const fileSchema = z.object({ id: numericId, format: z.string().nullable(), role: z.string(), sizeBytes: z.number().nullable().optional(), filename: z.string().nullable().optional() });
const bookSchema = z.object({
  id: numericId, title: z.string().nullable(), authors: z.array(z.union([z.string(), z.object({name: z.string()})])),
  files: z.array(fileSchema), genres: z.array(z.string()).nullish().transform(value=>value??[]), description: z.string().nullable().optional(),
  readingProgress: z.number().nullable().optional(), readStatus: z.object({status: z.string()}).nullable().optional(),
  seriesId:numericId.nullable().optional(),seriesName: z.string().nullable().optional(), seriesIndex: z.union([z.string(), z.number()]).nullable().optional(),
  addedAt: z.string(), hasCover: z.boolean().optional(), coverVersion: z.string().optional(),
}).passthrough();
const booksPageSchema = z.object({items: z.array(bookSchema), total: z.number(), page: z.number(), size: z.number()});
const seriesSchema=z.object({id:numericId,name:z.string(),bookCount:z.number().int().nonnegative(),readCount:z.number().int().nonnegative(),authors:z.array(z.string()),coverBookIds:z.array(numericId).optional().default([]),expectedBookCount:z.number().nullable().optional(),gapCount:z.number().optional()});
export type SeriesSummary=z.infer<typeof seriesSchema>;
export interface SeriesPage {items:SeriesSummary[];total:number;page:number;size:number;}
const authSchema = z.object({accessToken: z.string().min(1), refreshToken: z.string().optional(), user: z.object({id: numericId, username: z.string()})});
const annotationSchema = z.object({id: numericId, bookId: numericId, jumpFileId: numericId.nullable().optional(), cfi: z.string().nullable().optional(), pdf: z.unknown().optional(), text: z.string(), note: z.string().nullable(), color: z.string(), createdAt: z.string(), updatedAt: z.string().nullable().optional()}).passthrough();
const audioStateSchema=z.object({assetId:z.string(),positionMs:z.number().int().nonnegative(),percentage:z.number().min(0).max(100),completed:z.boolean(),capturedAt:z.string(),revision:z.number().int(),manifestRevision:z.string()});
const audioBookmarkSchema=z.object({id:z.string(),bookId:z.number(),positionMs:z.number().int().nonnegative(),chapterId:z.string().nullable(),title:z.string(),note:z.string().nullable(),createdAt:z.string(),updatedAt:z.string()});
const serverStatusSchema=z.enum(['unread','want_to_read','reading','on_hold','rereading','read','skimmed','abandoned']);
const collectionSchema=z.object({id:numericId,name:z.string(),mediaType:z.string().optional()});
const durationBreakdownSchema=z.object({totalSeconds:z.number().nonnegative(),readingSeconds:z.number().nonnegative(),listeningSeconds:z.number().nonnegative()});
const activityDaySchema=durationBreakdownSchema.extend({day:z.string(),sessionsCount:z.number().nonnegative(),bySource:z.record(z.string(),z.number())});
const activityCalendarSchema=z.object({year:z.number().int(),availableYears:z.array(z.number().int()),days:z.array(activityDaySchema)});
const statisticsSummarySchema=z.object({trackedBooks:z.number(),startedBooks:z.number(),inProgressBooks:z.number(),completedBooks:z.number(),meanProgressPercent:z.number()});
const activityOverviewSchema=z.object({generatedAt:z.string(),timezone:z.string(),snapshot:z.object({today:durationBreakdownSchema,lastSevenDays:durationBreakdownSchema,previousSevenDays:durationBreakdownSchema,currentStreak:z.number(),longestStreak:z.number(),completedBooksYtd:z.number()}),calendar:activityCalendarSchema,sources:z.object({windowDays:z.number(),totals:durationBreakdownSchema,slices:z.array(z.object({bucket:z.string(),totalSeconds:z.number()}))})});
const bookSessionSchema=z.object({id:numericId,bookFileId:numericId.nullable(),startedAt:z.string(),endedAt:z.string(),durationSeconds:z.number(),progressDelta:z.number().nullable(),endProgress:z.number().nullable(),format:z.string().nullable(),source:z.string().nullable(),sessionType:z.enum(['read','tts','listen']).optional()});
const bookSessionPageSchema=z.object({items:z.array(bookSessionSchema),total:z.number(),page:z.number(),pageSize:z.number(),stats:z.object({totalSessions:z.number(),totalSeconds:z.number(),avgDurationSeconds:z.number(),firstSessionAt:z.string().nullable(),lastSessionAt:z.string().nullable(),dailySummary:z.array(z.object({day:z.string(),totalMinutes:z.number()}))}).passthrough()});
export type ServerReadingStatistics=z.infer<typeof activityOverviewSchema>&{summary:z.infer<typeof statisticsSummarySchema>;currentCalendar:z.infer<typeof activityCalendarSchema>};
export type ServerBookSessions=z.infer<typeof bookSessionPageSchema>;
export interface OidcCallback {code:string;state:string;codeVerifier:string;nonce:string;redirectUri:string;}

export function normalizeServerUrl(input: string): string {
  const url = new URL(input.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ContractError('Use an http or https server address without credentials.');
  if (url.search || url.hash) throw new ContractError('Use the server address without a query or fragment.');
  return url.href.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}
function routeId(id: string): string {
  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) throw new ContractError('BookOrbit requires a positive numeric resource ID.');
  return id;
}
function transportBase(serverUrl:string,override?:string):string {
  if(!override) return normalizeServerUrl(serverUrl);
  if(override.startsWith('/')&&!override.startsWith('//')&&!/[?#]/.test(override)) return override.replace(/\/+$/,'');
  return normalizeServerUrl(override);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ContractError(`Unexpected BookOrbit ${label} response: ${result.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}`);
  return result.data;
}
const audioFormats = new Set(['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac']);
function format(value: string | null): BookFile['format'] | null {
  const f = value?.toLowerCase() ?? '';
  if (audioFormats.has(f)) return 'AUDIO';
  if (f === 'kepub') return 'EPUB';
  if (f === 'azw' || f === 'azw3') return 'MOBI';
  return ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'cb7'].includes(f) ? f.toUpperCase() as BookFile['format'] : null;
}
export interface BookQuery { page?: number; size?: number; query?: string; sort?: 'title' | 'addedAt' | 'lastReadAt'; direction?: 'asc' | 'desc'; libraryId?: string; media?:'all'|'books'|'audio'|'comics';readStatuses?:BookOrbitReadStatus[]; }
/** Avid pages are one-based; BookOrbit catalog routes are zero-based. */
function serverPage(page=1):number {
  if(!Number.isInteger(page)||page<1)throw new ContractError('Page numbers start at one.');
  return page-1;
}
export interface BooksPage { items: Book[]; total: number; page: number; size: number; }
export interface LibrarySummary { id: string; name: string; }
export interface LoginOptions { passwordLoginEnabled: boolean; allowRegistration: boolean; oidcProviders: {slug: string; displayName: string; enabled: boolean; clientId: string; scopes: string}[]; }
export interface AudioManifest {
  schema: 'bookorbit.audiobook-manifest'; schemaVersion: 2; revision: string;
  assets: {assetId: string; fileId: number; sequence: number; format: string; durationMs: number | null; sizeBytes: number | null; etag: string}[];
  chapters: {id: string; title: string; assetId: string; sequence: number; startMs: number; endMs: number; assetOffsetMs: number}[];
  totalDurationMs: number;
}
export interface AudioPlaybackState { assetId: string; positionMs: number; percentage: number; completed: boolean; capturedAt: string; revision: number; manifestRevision: string; }
export interface AudioPlaybackWrite { assetId: string; positionMs: number; capturedAt: string; operationId: string; baseRevision: number; manifestRevision: string; }
export interface AudioBookmark { id: string; bookId: number; positionMs: number; chapterId: string | null; title: string; note: string | null; createdAt: string; updatedAt: string; }
export interface PlaybackSource {
  bookId:string;fileId:string;title:string;authors:string[];coverUrl?:string;manifestRevision:string;
  tracks:{id:string;url:string;title?:string;duration?:number}[];
  chapters:{id:string;title:string;start:number;duration:number}[];
}
export interface AudioLocator {version:1;time?:number;trackId?:string;trackTime?:number;manifestRevision?:string;}
export function parseAudioLocator(locator:string):AudioLocator {
  if(locator.trim().startsWith('{')) return parse(z.object({version:z.literal(1).default(1),time:z.number().finite().nonnegative().optional(),trackId:z.string().optional(),trackTime:z.number().finite().nonnegative().optional(),manifestRevision:z.string().optional()}).refine(p=>p.time!==undefined||(p.trackId!==undefined&&p.trackTime!==undefined),'Audio position is missing'),JSON.parse(locator),'audio locator');
  const seconds=Number(locator);
  if(locator.trim()===''||!Number.isFinite(seconds)||seconds<0) throw new ContractError('Audio locator must contain source seconds.');
  return {version:1,trackTime:seconds};
}
function orderedAssets(manifest:AudioManifest):AudioManifest['assets'] { return [...manifest.assets].sort((a,b)=>a.sequence-b.sequence); }
function audioPosition(manifest:AudioManifest,anchor:Pick<ReadingAnchor,'fileId'|'locator'>):{asset:AudioManifest['assets'][number];positionMs:number;time:number} {
  const locator=parseAudioLocator(anchor.locator),assets=orderedAssets(manifest);
  if(locator.manifestRevision!==undefined&&locator.manifestRevision!==manifest.revision)throw new ProgressConflictError('The audiobook edition changed after this checkpoint.');
  let asset=assets.find(a=>String(a.fileId)===(locator.trackId??anchor.fileId)||a.assetId===locator.trackId);
  let trackTime=locator.trackTime;
  if(locator.trackId!==undefined && !asset) throw new ProgressConflictError('The saved audio track is absent from this manifest.');
  if(trackTime===undefined && locator.time!==undefined) {
    let remaining=locator.time*1000;
    asset=undefined;
    for(const candidate of assets) {
      if(candidate.durationMs===null) throw new ProgressConflictError('Audio durations are required to translate this book-wide position.');
      if(remaining<=candidate.durationMs) { asset=candidate;trackTime=remaining/1000;break; }
      remaining-=candidate.durationMs;
    }
  }
  if(!asset||trackTime===undefined) throw new ProgressConflictError('An exact audio asset and track position are required.');
  if(asset.durationMs!==null&&trackTime*1000>asset.durationMs+1000) throw new ProgressConflictError('The saved audio position exceeds this track. The edition may have changed.');
  const previous=assets.slice(0,assets.findIndex(a=>a.assetId===asset.assetId));
  if(previous.some(a=>a.durationMs===null)) throw new ProgressConflictError('Earlier track durations are unavailable; the source timeline cannot be verified.');
  const positionMs=Math.round(trackTime*1000);
  const time=(previous.reduce((sum,a)=>sum+a.durationMs!,0)+positionMs)/1000;
  // JSON checkpoints carry both timelines; reject mismatched editions rather than silently seeking elsewhere.
  if(locator.time!==undefined&&Math.abs(locator.time-time)>1.1) throw new ProgressConflictError('Book-wide and track-relative audio positions do not match this manifest.');
  return {asset,positionMs,time};
}
export function audioTimelineSeconds(locator:string):number {
  const parsed=parseAudioLocator(locator);
  if(parsed.time!==undefined) return parsed.time;
  if(parsed.trackId===undefined&&parsed.trackTime!==undefined) return parsed.trackTime;
  throw new ContractError('Audio notes require a book-wide source timestamp.');
}

export class BookOrbitClient {
  readonly baseUrl: string;
  readonly readOnly: boolean;
  private readonly transport: typeof fetch;
  private readonly endpoint: string;
  private refreshInFlight?: Promise<void>;
  constructor(public session: Session, private readonly options: ClientOptions = {}) {
    this.baseUrl = normalizeServerUrl(session.profile.url);
    this.endpoint = transportBase(session.profile.url,options.transportBaseUrl);
    this.readOnly = options.readOnly ?? false;
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  static async login(profile: ServerProfile, password: string, options: ClientOptions = {}): Promise<Session> {
    const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await transport(`${transportBase(profile.url,options.transportBaseUrl)}/api/v1/auth/login`, {
      method: 'POST', credentials: options.clientKind === 'native' ? 'omit' : 'include', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: profile.username, password, clientKind: options.clientKind ?? 'web', deviceLabel: 'Avid'}),
    });
    if (!response.ok) throw await BookOrbitClient.responseError(response);
    const auth = parse(authSchema, await response.json(), 'authentication');
    return {profile: {...profile, url: normalizeServerUrl(profile.url), username: auth.user.username}, accessToken: auth.accessToken, refreshToken: auth.refreshToken, userId: auth.user.id, clientKind: options.clientKind ?? 'web'};
  }
  static async loginOptions(url: string, options: ClientOptions = {}): Promise<LoginOptions> {
    const transport=options.fetch??globalThis.fetch.bind(globalThis);
    const response = await transport(`${transportBase(url,options.transportBaseUrl)}/api/v1/auth/login-options`, {credentials:'include'});
    if (!response.ok) throw await BookOrbitClient.responseError(response);
    return parse(z.object({passwordLoginEnabled:z.boolean(),allowRegistration:z.boolean(),oidcProviders:z.array(z.object({slug:z.string(),displayName:z.string(),enabled:z.boolean(),clientId:z.string(),scopes:z.string()}))}), await response.json(), 'login options');
  }
  /** Low-level contract only. The app must implement PKCE and a server-allowlisted callback before enabling SSO. */
  static async createOidcState(url:string,providerSlug:string,options:ClientOptions={}):Promise<{state:string;authorizationEndpoint:string}> {
    if(!/^[a-z0-9][a-z0-9_-]*$/i.test(providerSlug))throw new ContractError('Invalid sign-in provider.');
    const response=await(options.fetch??globalThis.fetch.bind(globalThis))(`${transportBase(url,options.transportBaseUrl)}/api/v1/auth/oidc/${encodeURIComponent(providerSlug)}/state`,{method:'POST',credentials:'include'});
    if(!response.ok)throw await BookOrbitClient.responseError(response);
    return parse(z.object({state:z.string().min(1),authorizationEndpoint:z.string().url()}),await response.json(),'OIDC state');
  }
  static async exchangeOidcCode(profile:ServerProfile,callback:OidcCallback,options:ClientOptions={}):Promise<Session> {
    if(!callback.code||!callback.state||!callback.codeVerifier||!callback.nonce||!callback.redirectUri)throw new ContractError('Complete OIDC callback and PKCE state are required.');
    const response=await(options.fetch??globalThis.fetch.bind(globalThis))(`${transportBase(profile.url,options.transportBaseUrl)}/api/v1/auth/oidc/callback`,{method:'POST',credentials:options.clientKind==='native'?'omit':'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({...callback,clientKind:options.clientKind??'web',deviceLabel:'Avid'})});
    if(!response.ok)throw await BookOrbitClient.responseError(response);
    const auth=parse(authSchema.extend({mode:z.literal('login')}),await response.json(),'OIDC login');
    return {profile:{...profile,url:normalizeServerUrl(profile.url),username:auth.user.username},userId:auth.user.id,accessToken:auth.accessToken,refreshToken:auth.refreshToken,clientKind:options.clientKind??'web'};
  }
  private static async responseError(response: Response) {
    let detail: unknown;
    try { detail = await response.json(); } catch { /* Non-JSON reverse proxy response. */ }
    const message = detail && typeof detail === 'object' && 'message' in detail ? String(detail.message) : `BookOrbit request failed (${response.status}).`;
    return new BookOrbitError(message, response.status, detail);
  }
  private async response(path: string, init: RequestInit = {}, mutation = false, retry = true): Promise<Response> {
    if (mutation && this.readOnly) throw new ReadOnlyError();
    const requestToken = this.session.accessToken;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${requestToken}`);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await this.transport(`${this.endpoint}/api/v1/${path}`, {...init, headers, credentials:this.session.clientKind === 'native' ? 'omit' : 'include'});
    if (response.status === 401 && retry && path !== 'auth/refresh') {
      // A delayed response for an old token must not rotate the replacement again.
      if (this.refreshInFlight || this.session.accessToken === requestToken) {
        if (!this.refreshInFlight) this.refreshInFlight = this.refresh().finally(() => { this.refreshInFlight = undefined; });
        await this.refreshInFlight;
      }
      return this.response(path, init, mutation, false);
    }
    if (!response.ok) throw await BookOrbitClient.responseError(response);
    return response;
  }
  private async json(path: string, init: RequestInit = {}, mutation = false): Promise<unknown> {
    const response = await this.response(path, init, mutation);
    const body = await response.text();
    return body ? JSON.parse(body) : undefined;
  }
  private async refresh(): Promise<void> {
    if (this.options.refreshSession) {
      const previous = this.session;
      const next = await this.options.refreshSession(structuredClone(previous));
      if (this.session !== previous || !next || typeof next.accessToken !== 'string' || !next.accessToken.trim() ||
        next.userId !== previous.userId || next.profile?.id !== previous.profile.id ||
        normalizeServerUrl(next.profile.url) !== this.baseUrl || (next.clientKind ?? 'web') !== (previous.clientKind ?? 'web'))
        throw new BookOrbitError('The refreshed session belongs to a different connection. Sign in again.', 401);
      this.session = {...next, profile:{...next.profile, url:this.baseUrl}};
      await this.options.onSessionChange?.(this.session);
      return;
    }
    if (this.session.clientKind === 'native' && !this.session.refreshToken) throw new BookOrbitError('The native session has expired. Sign in again.', 401);
    const value = await this.json('auth/refresh', {method:'POST',body:JSON.stringify(this.session.refreshToken ? {refreshToken:this.session.refreshToken} : {})});
    const result = parse(z.object({accessToken:z.string(),refreshToken:z.string().optional()}),value,'refresh');
    this.session = {...this.session, accessToken:result.accessToken, refreshToken:result.refreshToken ?? this.session.refreshToken};
    await this.options.onSessionChange?.(this.session);
  }
  /** Verify the authenticated server identity before adopting a saved account or native player. */
  async getCurrentUser(signal?: AbortSignal): Promise<{id:string;username:string;active:boolean}> {
    const user = parse(z.object({id:numericId,username:z.string(),active:z.boolean()}),await this.json('auth/me',{signal}),'current user');
    if (user.id !== this.session.userId || !user.active) throw new BookOrbitError('The saved session no longer belongs to this active account. Sign in again.', 401);
    return user;
  }
  /** Revoke this server session even for read-only connections. Local credential cleanup is the caller's responsibility. */
  async logout(signal?: AbortSignal): Promise<void> {
    await this.response('auth/logout',{method:'POST',signal,body:JSON.stringify(this.session.refreshToken ? {refreshToken:this.session.refreshToken} : {})},false,false);
  }
  async getServerInfo(): Promise<{version:string;features:string[]}> {
    return parse(z.object({version:z.string(),features:z.array(z.string()).default([])}),await this.json('app-info'),'server info');
  }
  async listLibraries(): Promise<LibrarySummary[]> {
    return parse(z.array(z.object({id:numericId,name:z.string()})),await this.json('libraries'),'libraries');
  }
  private mapBook(value: z.infer<typeof bookSchema>): Book {
    // The audiobook manifest service selects audio by format, independently of file role.
    const files = value.files.filter(f => ['primary','content'].includes(f.role)||audioFormats.has(f.format?.toLowerCase()??'')).flatMap(f => {
      const mapped = format(f.format);
      return mapped ? [{id:f.id,name:f.filename ?? `${value.title ?? 'Book'}.${f.format}`,format:mapped,size:f.sizeBytes ?? undefined,url:this.fileUrl(f.id)}] : [];
    });
    const primary = value.files.find(f => f.role === 'primary');
    const bookFormat = format(primary?.format ?? null) ?? files[0]?.format ?? 'EPUB';
    const status = value.readStatus?.status;
    const colors = ['#b32148','#176d77','#53469a','#d9a633','#377961','#da7654'];
    return {id:value.id,title:value.title ?? 'Untitled',authors:value.authors.map(a=>typeof a==='string'?a:a.name),description:value.description ?? '',
      format:bookFormat,files,color:colors[Number(value.id)%colors.length],progress:Math.max(0,Math.min(1,(value.readingProgress ?? 0)/100)),
      status:status==='read' || status==='skimmed' ? 'finished' : ['reading','rereading','on_hold'].includes(status ?? '') ? 'reading' : 'unread',
      serverStatus:serverStatusSchema.safeParse(status).success?status as BookOrbitReadStatus:undefined,
      series:value.seriesName ?? undefined,seriesId:value.seriesId??undefined,seriesIndex:value.seriesIndex==null?undefined:Number(value.seriesIndex),genres:value.genres,addedAt:value.addedAt,
      coverUrl:value.hasCover===false?undefined:this.coverUrl(value.id,value.coverVersion),};
  }
  async listBooks(query: BookQuery = {}, signal?: AbortSignal): Promise<BooksPage> {
    const page = query.page ?? 1, size = Math.min(200,Math.max(1,query.size ?? 100));
    const value = await this.json(query.libraryId ? `libraries/${routeId(query.libraryId)}/books` : 'books/query', {
      method:'POST',signal,body:JSON.stringify(this.bookQueryBody({...query,page,size})),
    }); // POST query is explicitly read-only in the pinned controller.
    const result = parse(booksPageSchema,value,'books page');
    return {...result,page:result.page+1,items:result.items.map(book=>this.mapBook(book))};
  }
  private bookQueryBody(query:BookQuery):Record<string,unknown> {
    const rules:Record<string,unknown>[]=[];
    const formats=query.media==='audio'?[...audioFormats]:query.media==='comics'?['cbz','cbr','cb7']:query.media==='books'?['epub','kepub','mobi','azw3','azw','pdf']:undefined;
    if(formats)rules.push({type:'rule',field:'format',operator:'includesAny',value:formats});
    if(query.readStatuses?.length)rules.push({type:'rule',field:'readStatus',operator:'includesAny',value:query.readStatuses.map(status=>parse(serverStatusSchema,status,'reading status'))});
    return {sort:[{field:query.sort??'addedAt',dir:query.direction??'desc'}],pagination:{page:serverPage(query.page),size:query.size??100},q:query.query??'',collapseSeries:false,...(rules.length?{filter:{type:'group',join:'AND',rules}}:{})};
  }
  async getBook(id: string): Promise<Book> { return this.mapBook(parse(bookSchema,await this.json(`books/${routeId(id)}`),'book')); }
  async listSeries(options:{page?:number;size?:number;query?:string}={},signal?:AbortSignal):Promise<SeriesPage> {
    const size=Math.min(100,Math.max(1,options.size??24));
    const params=new URLSearchParams({page:String(serverPage(options.page)),size:String(size),sort:'name',order:'asc'});
    if(options.query)params.set('q',options.query);
    const value=parse(z.object({items:z.array(seriesSchema),total:z.number(),page:z.number(),size:z.number()}),await this.json(`series?${params}`,{signal}),'series page');
    return {...value,page:value.page+1};
  }
  async getSeriesBooks(seriesId:string,page=1,size=48,signal?:AbortSignal):Promise<BooksPage> {
    const result=parse(booksPageSchema,await this.json(`series/${routeId(seriesId)}/books?page=${serverPage(page)}&size=${Math.min(100,Math.max(1,size))}&sort=seriesIndex&order=asc`,{signal}),'series books');
    return {...result,page:result.page+1,items:result.items.map(book=>this.mapBook(book))};
  }
  async listCollections(): Promise<Collection[]> {
    const items = parse(z.array(collectionSchema),await this.json('collections'),'collections');
    return items.filter(c=>c.mediaType!=='podcasts').map(c=>({id:c.id,name:c.name,bookIds:[]}));
  }
  /** Owned picker targets. bookIds describes only this selected book, not complete membership. */
  async getBookCollections(bookId:string):Promise<Collection[]> {
    const id=routeId(bookId);
    const items=parse(z.array(collectionSchema.extend({memberCount:z.number().int().nonnegative()})),await this.json(`collections?bookIds=${id}`),'book collection membership');
    return items.filter(c=>c.mediaType!=='podcasts').map(c=>({id:c.id,name:c.name,bookIds:c.memberCount>0?[id]:[]}));
  }
  async createCollection(input:{name:string;icon?:string;description?:string}):Promise<Collection> {
    if(!input.name.trim()||input.name.trim().length>255)throw new ContractError('Collection names must contain 1 to 255 characters.');
    const value=parse(collectionSchema,await this.json('collections',{method:'POST',body:JSON.stringify({name:input.name.trim(),icon:input.icon??'Library',description:input.description,mediaType:'books',isPublic:false,syncToKobo:false})},true),'created collection');
    return {id:value.id,name:value.name,bookIds:[]};
  }
  async addCollectionBooks(id:string,bookIds:string[]):Promise<Collection> { return this.changeCollectionBooks(id,bookIds,'POST'); }
  async removeCollectionBooks(id:string,bookIds:string[]):Promise<Collection> { return this.changeCollectionBooks(id,bookIds,'DELETE'); }
  private async changeCollectionBooks(id:string,bookIds:string[],method:'POST'|'DELETE'):Promise<Collection> {
    if(!bookIds.length)throw new ContractError('Select at least one book.');
    const ids=[...new Set(bookIds.map(bookId=>Number(routeId(bookId))))];
    const value=parse(collectionSchema,await this.json(`collections/${routeId(id)}/books`,{method,body:JSON.stringify({bookIds:ids})},true),'updated collection');
    // Mutation returns a summary, not the complete member list. Caller reloads the selected collection page.
    return {id:value.id,name:value.name,bookIds:[]};
  }
  async getCollectionBooks(id: string, page = 1, size = 100,query?:Pick<BookQuery,'query'|'sort'|'direction'|'media'|'readStatuses'>,signal?:AbortSignal): Promise<BooksPage> {
    const value=query?await this.json(`collections/${routeId(id)}/books/query`,{method:'POST',signal,body:JSON.stringify(this.bookQueryBody({...query,page,size}))}):await this.json(`collections/${routeId(id)}/books?page=${serverPage(page)}&size=${size}`,{signal});
    const result = parse(booksPageSchema,value,'collection books');
    return {...result,page:result.page+1,items:result.items.map(b=>this.mapBook(b))};
  }
  async listSmartScopes(): Promise<{id:string;name:string}[]> {
    return parse(z.array(z.object({id:numericId,name:z.string()})),await this.json('smart-scopes'),'smart scopes');
  }
  async getSmartScopeBooks(id: string, page=1, size=100): Promise<BooksPage> {
    const result=parse(booksPageSchema,await this.json(`smart-scopes/${routeId(id)}/books?page=${serverPage(page)}&size=${size}`),'smart scope books');
    return {...result,page:result.page+1,items:result.items.map(b=>this.mapBook(b))};
  }
  fileUrl(id: string): string { return `${this.endpoint}/api/v1/books/files/${routeId(id)}/serve`; }
  coverUrl(id: string, version?: string): string { return `${this.endpoint}/api/v1/books/${routeId(id)}/cover${version?`?v=${encodeURIComponent(version)}`:''}`; }
  /** URLs intentionally contain no credentials. Native streams supply headers; browsers use cookies or fetched blobs. */
  streamHeaders(): Record<string,string> { return {Authorization:`Bearer ${this.session.accessToken}`}; }
  async getFileBlob(id: string, signal?: AbortSignal): Promise<Blob> { return (await this.response(`books/files/${routeId(id)}/serve`,{signal})).blob(); }
  async coverBlob(id: string, signal?: AbortSignal): Promise<Blob> { return (await this.response(`books/${routeId(id)}/cover`,{signal})).blob(); }
  /** Read-only KOReader context. EPUB translation stays on BookOrbit; native locators remain opaque. */
  async getKoreaderCheckpoint(identity: KoreaderFileIdentity): Promise<KoreaderCheckpoint | null> {
    const binding = { ...identity, serverUrl: this.baseUrl, userId: this.session.userId };
    const value = await this.json(`books/files/${routeId(identity.fileId)}/progress`);
    try {
      const checkpoint = parseKoreaderCheckpoint(binding, value);
      if (!checkpoint?.nativeLocator) return checkpoint;
      let syncInfo: unknown;
      try { syncInfo = await this.json(`koreader/books/${routeId(identity.bookId)}/progress`); }
      catch (error) { if (!(error instanceof BookOrbitError && [403, 404, 405].includes(error.status))) throw error; }
      return parseKoreaderCheckpoint(binding, value, syncInfo);
    } catch (error) {
      if (error instanceof KoreaderContractError) throw error.reason === 'identity' ? new ProgressConflictError(error.message) : new ContractError(error.message);
      throw error;
    }
  }
  async getProgress(identity: Pick<ReadingAnchor,'bookId'|'fileId'|'kind'>): Promise<ReadingAnchor | null> {
    if(identity.kind==='audio') {
      const state=await this.getAudioPlaybackState(identity.bookId);
      if(!state) return null;
      const manifest=await this.getAudioManifest(identity.bookId);
      if(state.manifestRevision!==manifest.revision) throw new ProgressConflictError('The audiobook edition changed after this position was saved.');
      const asset=manifest.assets.find(a=>a.assetId===state.assetId);
      if(!asset) throw new ProgressConflictError('The saved audiobook asset is no longer available.');
      const position=audioPosition(manifest,{fileId:String(asset.fileId),locator:JSON.stringify({version:1,trackId:String(asset.fileId),trackTime:state.positionMs/1000})});
      return {...identity,locator:JSON.stringify({version:1,trackId:String(asset.fileId),trackTime:state.positionMs/1000,time:position.time,manifestRevision:manifest.revision}),progress:state.percentage/100,updatedAt:state.capturedAt};
    }
    const checkpoint = await this.getKoreaderCheckpoint({ ...identity, kind: identity.kind });
    if (!checkpoint) return null;
    try { return koreaderRestoreAnchor(checkpoint, { ...identity, kind: identity.kind, serverUrl: this.baseUrl, userId: this.session.userId }); }
    catch (error) { if (error instanceof KoreaderContractError) throw new ProgressConflictError(error.message); throw error; }
  }
  async saveProgress(anchor: ReadingAnchor, options:{operationId?:string}={}): Promise<void> {
    if(this.readOnly) throw new ReadOnlyError();
    if (!Number.isFinite(anchor.progress)||anchor.progress<0||anchor.progress>1) throw new ContractError('Progress must be between 0 and 1.');
    const percentage = anchor.progress*100;
    if (anchor.kind==='audio') {
      let manifest:AudioManifest,state:AudioPlaybackState|null;
      try { [manifest,state]=await Promise.all([this.getAudioManifest(anchor.bookId),this.getAudioPlaybackState(anchor.bookId)]); }
      catch(error) { if(error instanceof BookOrbitError&&[404,405].includes(error.status)) throw new ProgressConflictError('This server does not expose the verified revisioned audiobook state contract. No progress was written.'); throw error; }
      const captured=Date.parse(anchor.updatedAt);
      if(!Number.isFinite(captured)) throw new ContractError('Audio checkpoint source time is required.');
      const position=audioPosition(manifest,anchor);
      if(state&&state.manifestRevision!==manifest.revision) throw new ProgressConflictError('Audiobook manifest revision changed; review the saved position.');
      if(state&&Date.parse(state.capturedAt)>captured) {
        if(state.assetId===position.asset.assetId&&Math.abs(state.positionMs-position.positionMs)<=1) return;
        throw new ProgressConflictError('A newer audiobook checkpoint exists on the server.');
      }
      try {
        await this.saveAudioPlaybackState(anchor.bookId,{assetId:position.asset.assetId,positionMs:position.positionMs,capturedAt:anchor.updatedAt,operationId:options.operationId??crypto.randomUUID(),baseRevision:state?.revision??0,manifestRevision:manifest.revision});
      } catch(error) { if(error instanceof BookOrbitError&&[409,412].includes(error.status)) throw new ProgressConflictError('The audiobook state or edition changed during synchronization.');throw error; }
    } else {
      let body: ReturnType<typeof bookOrbitTextProgress>;
      try { body = bookOrbitTextProgress(anchor, { bookId: anchor.bookId, fileId: anchor.fileId, kind: anchor.kind, serverUrl: this.baseUrl, userId: this.session.userId }); }
      catch (error) { if (error instanceof KoreaderContractError) throw error.reason === 'identity' ? new ProgressConflictError(error.message) : new ContractError(error.message); throw error; }
      await this.json(`books/files/${routeId(anchor.fileId)}/progress`,{method:'POST',body:JSON.stringify(body)},true);
    }
  }
  async setStatus(id: string, status: Book['status']|'want_to_read'|'abandoned'|'skimmed'): Promise<void> {
    await this.setReadStatus(id,status==='finished'?'read':status);
  }
  async setReadStatus(id:string,status:BookOrbitReadStatus):Promise<void> {
    parse(serverStatusSchema,status,'reading status');
    await this.json(`books/${routeId(id)}/status`,{method:'PATCH',body:JSON.stringify({status})},true);
  }
  async updateMetadata(id: string, fields: {title?:string;authors?:string[];description?:string;genres?:string[];seriesName?:string|null;publishedYear?:number|null}): Promise<Book> {
    return this.mapBook(parse(bookSchema,await this.json(`books/${routeId(id)}/metadata`,{method:'PATCH',body:JSON.stringify(fields)},true),'updated book'));
  }
  private mapAnnotation(value: z.infer<typeof annotationSchema>, fileId: string): Annotation {
    return {id:value.id,bookId:value.bookId,fileId:value.jumpFileId ?? fileId,kind:value.note?'note':'highlight',quote:value.text,text:value.note ?? '',color:value.color,locator:value.cfi ?? JSON.stringify(value.pdf),createdAt:value.createdAt,updatedAt:value.updatedAt ?? value.createdAt};
  }
  async getAnnotations(bookId: string, fileId: string): Promise<Annotation[]> {
    return parse(z.array(annotationSchema),await this.json(`books/${routeId(bookId)}/annotations`),'annotations').map(a=>this.mapAnnotation(a,fileId));
  }
  async saveAnnotation(annotation: Annotation): Promise<Annotation> {
    if(this.readOnly) throw new ReadOnlyError();
    if (annotation.kind==='audio') {
      const existing=(await this.getAudioBookmarks(annotation.bookId)).find(note=>note.id===annotation.id);
      const title=(annotation.quote||'Audio note').slice(0,500);
      const saved=existing
        ? await this.updateAudioBookmark(annotation.bookId,annotation.id,{title,note:annotation.text||null})
        : await this.createAudioBookmark(annotation.bookId,{clientId:annotation.id,positionMs:Math.round(audioTimelineSeconds(annotation.locator)*1000),title,note:annotation.text||undefined});
      return this.mapAudioAnnotation(saved,annotation.fileId,annotation.color);
    }
    const exists=/^\d+$/.test(annotation.id);
    let location: Record<string,unknown> = {cfi:annotation.locator};
    if (annotation.locator.trim().startsWith('{')) {
      const pdf = parse(z.object({page:z.number().int().min(0),rect:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}),rects:z.array(z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()})).min(1)}),JSON.parse(annotation.locator),'PDF annotation locator');
      location={pdf};
    }
    const body = exists ? {note:annotation.text || null,color:annotation.color} : {...location,bookFileId:Number(routeId(annotation.fileId)),text:annotation.quote,color:annotation.color,note:annotation.text||null};
    const result=await this.json(`books/${routeId(annotation.bookId)}/annotations${exists?`/${routeId(annotation.id)}`:''}`,{method:exists?'PATCH':'POST',body:JSON.stringify(body)},true);
    return this.mapAnnotation(parse(annotationSchema,result,'annotation'),annotation.fileId);
  }
  async deleteAnnotation(bookId:string,id:string,kind?:Annotation['kind']): Promise<void> {
    if(kind==='audio') return this.deleteAudioBookmark(bookId,id);
    await this.json(`books/${routeId(bookId)}/annotations/${routeId(id)}`,{method:'DELETE'},true);
  }
  private mapAudioAnnotation(bookmark:AudioBookmark,fileId:string,color='sand'):Annotation {
    return {id:bookmark.id,bookId:String(bookmark.bookId),fileId,kind:'audio',quote:bookmark.title,text:bookmark.note??'',color,locator:JSON.stringify({version:1,time:bookmark.positionMs/1000}),createdAt:bookmark.createdAt,updatedAt:bookmark.updatedAt};
  }
  async getAudioAnnotations(bookId:string,fileId:string):Promise<Annotation[]> { return (await this.getAudioBookmarks(bookId)).map(note=>this.mapAudioAnnotation(note,fileId)); }
  async getReaderPreferences(fileId:string): Promise<{settings:Record<string,unknown>|null;isCustomized:boolean}> {
    return parse(z.object({settings:z.record(z.string(),z.unknown()).nullable(),isCustomized:z.boolean()}),await this.json(`reader/preferences/${routeId(fileId)}`),'reader preferences');
  }
  async patchPreferences(fileId:string,set:Record<string,unknown>,unset:string[]=[]): Promise<void> { await this.json(`reader/preferences/${routeId(fileId)}`,{method:'PATCH',body:JSON.stringify({set,unset})},true); }
  async saveReadingSession(session:ReadingSession,fileId:string,options:{endedAt?:string;endProgress?:number;progressDelta?:number;source?:'ios'|'android'|'watchos'}={}):Promise<void> {
    const startedAt=new Date(session.startedAt);
    if (!Number.isFinite(startedAt.getTime())||!Number.isFinite(session.duration)||session.duration<0||!session.id.length||session.id.length>64) throw new ContractError('Invalid reading session.');
    const endedAt=options.endedAt ?? new Date(startedAt.getTime()+session.duration*1000).toISOString();
    if(!Number.isFinite(Date.parse(endedAt))||Date.parse(endedAt)<startedAt.getTime()) throw new ContractError('Reading session end must follow its start.');
    if(options.endProgress!==undefined&&(!Number.isFinite(options.endProgress)||options.endProgress<0||options.endProgress>1)) throw new ContractError('Session progress must be between 0 and 1.');
    if(options.progressDelta!==undefined&&!Number.isFinite(options.progressDelta)) throw new ContractError('Session progress change must be finite.');
    await this.json(`books/files/${routeId(fileId)}/sessions`,{method:'POST',body:JSON.stringify({sessionId:session.id,startedAt:session.startedAt,endedAt,durationSeconds:Math.floor(session.duration),sessionType:{reading:'read',listening:'listen',speech:'tts'}[session.kind],...(options.endProgress==null?{}:{endProgress:options.endProgress*100}),...(options.progressDelta==null?{}:{progressDelta:options.progressDelta*100}),...(options.source?{source:options.source}:{})})},true);
  }
  /** Server-owned totals and calendar. Seconds stay seconds; no local-cache totals are blended in. */
  async getReadingStatistics(year?:number):Promise<ServerReadingStatistics> {
    if(year!==undefined&&(!Number.isInteger(year)||year<1970||year>2100))throw new ContractError('Choose a calendar year between 1970 and 2100.');
    const [overview,summary]=await Promise.all([
      this.json('user-statistics/activity-overview').then(value=>parse(activityOverviewSchema,value,'activity overview')),
      this.json('user-statistics/summary').then(value=>parse(statisticsSummarySchema,value,'statistics summary')),
    ]);
    const calendar=year===undefined||year===overview.calendar.year?overview.calendar:parse(activityCalendarSchema,await this.json(`user-statistics/activity-calendar/${year}`),'activity calendar');
    return {...overview,calendar,summary,currentCalendar:overview.calendar};
  }
  async getBookSessions(bookId:string,options:{page?:number;pageSize?:number}={}):Promise<ServerBookSessions> {
    const page=options.page??1,pageSize=options.pageSize??25;
    if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ContractError('Invalid reading-session pagination.');
    return parse(bookSessionPageSchema,await this.json(`books/${routeId(bookId)}/sessions?page=${page}&pageSize=${pageSize}&sortBy=startedAt&sortDir=desc`),'book sessions');
  }
  async uploadBook(libraryId:string,file:File,signal?:AbortSignal):Promise<unknown> {
    const body=new FormData(); body.append('file',file);
    return this.json(`libraries/${routeId(libraryId)}/upload`,{method:'POST',body,signal},true);
  }
  async getAudioManifest(bookId:string):Promise<AudioManifest> {
    const asset=z.object({assetId:z.string(),fileId:z.number(),sequence:z.number(),format:z.string(),durationMs:z.number().nullable(),sizeBytes:z.number().nullable(),etag:z.string()});
    const chapter=z.object({id:z.string(),title:z.string(),assetId:z.string(),sequence:z.number(),startMs:z.number(),endMs:z.number(),assetOffsetMs:z.number()});
    return parse(z.object({schema:z.literal('bookorbit.audiobook-manifest'),schemaVersion:z.literal(2),revision:z.string(),assets:z.array(asset),chapters:z.array(chapter),totalDurationMs:z.number()}),await this.json(`audiobooks/${routeId(bookId)}/manifest`),'audiobook manifest');
  }
  /** Explicit file selection prevents the server's primary-file fallback from linking another edition. */
  async getMediaOverlayPlaylist(bookId:string,fileId:string):Promise<MediaOverlayPlaylist> {
    const value=parse(mediaOverlayPlaylistSchema,await this.json(`epub/${routeId(bookId)}/media-overlay?fileId=${routeId(fileId)}`),'EPUB media-overlay playlist');
    if(String(value.bookId)!==bookId||String(value.fileId)!==fileId)throw new ProgressConflictError('The narration playlist belongs to a different book or EPUB file.');
    return value;
  }
  mediaOverlayResourceUrl(bookId:string,fileId:string,href:string):string {
    const path=mediaOverlayPath(href).split('/').map(encodeURIComponent).join('/');
    return `${this.endpoint}/api/v1/epub/${routeId(bookId)}/media-overlay/file/${path}?fileId=${routeId(fileId)}`;
  }
  /** Streaming source for PlaybackController: cookie/proxy URLs, never complete audiobook blobs. */
  async getPlaybackSource(book:Book):Promise<PlaybackSource> {
    const manifest=await this.getAudioManifest(book.id),assets=orderedAssets(manifest);
    if(!assets.length) throw new ContractError('This audiobook manifest contains no playable assets.');
    if(assets.slice(0,-1).some(asset=>asset.durationMs===null)) throw new ProgressConflictError('Track durations are required for exact multi-track playback.');
    return {bookId:book.id,fileId:book.files.find(f=>f.format==='AUDIO')?.id??String(assets[0].fileId),title:book.title,authors:book.authors,coverUrl:book.coverUrl,manifestRevision:manifest.revision,
      tracks:assets.map(asset=>({id:String(asset.fileId),url:this.audioAssetUrl(book.id,asset.assetId),duration:asset.durationMs===null?undefined:asset.durationMs/1000})),
      chapters:[...manifest.chapters].sort((a,b)=>a.sequence-b.sequence).map(chapter=>({id:chapter.id,title:chapter.title,start:chapter.startMs/1000,duration:(chapter.endMs-chapter.startMs)/1000})),};
  }
  audioAssetUrl(bookId:string,assetId:string):string { return `${this.endpoint}/api/v1/audiobooks/${routeId(bookId)}/assets/${encodeURIComponent(assetId)}/content`; }
  /** Explicit alignment verification only; normal playback continues to stream. */
  async getAudioAssetBlob(bookId:string,assetId:string,options:{signal?:AbortSignal;maxBytes?:number}={}):Promise<Blob> {
    const maxBytes=options.maxBytes??64*1024*1024;
    if(!assetId||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)throw new ContractError('Audio verification accepts complete assets up to 64 MiB.');
    options.signal?.throwIfAborted();
    return boundedBlob(await this.response(`audiobooks/${routeId(bookId)}/assets/${encodeURIComponent(assetId)}/content`,{signal:options.signal}),maxBytes,options.signal);
  }
  async getAudioPlaybackState(bookId:string):Promise<AudioPlaybackState|null> { return parse(audioStateSchema.nullable(),await this.json(`audiobooks/${routeId(bookId)}/playback-state`),'audio state'); }
  async saveAudioPlaybackState(bookId:string,state:AudioPlaybackWrite):Promise<AudioPlaybackState> { return parse(audioStateSchema,await this.json(`audiobooks/${routeId(bookId)}/playback-state`,{method:'PUT',body:JSON.stringify(state)},true),'audio state'); }
  async getAudioBookmarks(bookId:string):Promise<AudioBookmark[]> { return parse(z.array(audioBookmarkSchema),await this.json(`audiobooks/${routeId(bookId)}/bookmarks`),'audio bookmarks'); }
  async createAudioBookmark(bookId:string,bookmark:{clientId:string;positionMs:number;chapterId?:string;title:string;note?:string}):Promise<AudioBookmark> { return parse(audioBookmarkSchema,await this.json(`audiobooks/${routeId(bookId)}/bookmarks`,{method:'POST',body:JSON.stringify(bookmark)},true),'audio bookmark'); }
  async updateAudioBookmark(bookId:string,id:string,patch:{title?:string;note?:string|null}):Promise<AudioBookmark> { return parse(audioBookmarkSchema,await this.json(`audiobooks/${routeId(bookId)}/bookmarks/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(patch)},true),'audio bookmark'); }
  async deleteAudioBookmark(bookId:string,id:string):Promise<void> { await this.json(`audiobooks/${routeId(bookId)}/bookmarks/${encodeURIComponent(id)}`,{method:'DELETE'},true); }
}
