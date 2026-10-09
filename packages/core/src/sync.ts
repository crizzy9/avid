import { audioTimelineSeconds, BookOrbitClient, BookOrbitError, ContractError, ProgressConflictError, ReadOnlyError } from './bookorbit';
import { accountScope, LibraryRepository, type OutboxOperation } from './repository';
import type { Annotation } from './types';

export interface SyncResult {sent:number;conflicts:number;failed:number;readOnly:boolean;}
/** Foreground outbox, with explicit conflicts. No percentage-based conflict winner. */
export class SyncCoordinator {
  private running?:Promise<SyncResult>;
  constructor(private readonly repository:LibraryRepository,private readonly client:BookOrbitClient) {
    if(repository.scope!==accountScope(client.session)) throw new Error('Repository and server account scopes do not match.');
  }
  flush():Promise<SyncResult> {
    if(!this.running) this.running=this.performFlush().finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async performFlush():Promise<SyncResult> {
    const result:SyncResult={sent:0,conflicts:0,failed:0,readOnly:this.client.readOnly};
    if(this.client.readOnly) return result;
    const operations=await this.repository.pendingOperations();
    for(const snapshot of operations) {
      const operation=await this.repository.getOperation(snapshot.id);
      if(!operation) continue;
      if(['conflict','failed'].includes(operation.status)) continue;
      if(operation.nextAttemptAt && Date.parse(operation.nextAttemptAt)>Date.now()) continue;
      await this.repository.updateOperation(operation.id,{status:'syncing',attempts:operation.attempts+1});
      try {
        const outcome=await this.send(operation);
        if(outcome==='conflict') { result.conflicts++; continue; }
        await this.repository.acknowledge(operation.id);
        result.sent++;
      } catch(error) {
        if(error instanceof ReadOnlyError) { result.readOnly=true; break; }
        const message=error instanceof Error?error.message:String(error);
        const status=error instanceof BookOrbitError?error.status:0;
        if(error instanceof ProgressConflictError || (operation.payload.kind==='progress'&&operation.payload.anchor.kind==='audio'&&(error instanceof ContractError||[404,409,412].includes(status)))) {
          await this.conflict(operation,message);result.conflicts++;continue;
        }
        const isAnnotationCreate=operation.payload.kind==='annotation'&&!/^\d+$/.test(operation.payload.annotation.id)&&!operation.payload.annotation.deleted;
        const uncertain=isAnnotationCreate && !(error instanceof ContractError) && (status===0||status>=500);
        const retryable=!(error instanceof ContractError)&&(status===0||status===429||status>=500);
        await this.repository.updateOperation(operation.id,{status:uncertain?'uncertain':retryable?'pending':'failed',error:message,nextAttemptAt:retryable?new Date(Date.now()+Math.min(300000,1000*2**Math.min(operation.attempts,8))).toISOString():undefined});
        result.failed++;
        if(status===0||status===401||status===429||status>=500) break;
      }
    }
    return result;
  }
  private async conflict(operation:OutboxOperation,message:string):Promise<'conflict'> {
    await this.repository.updateOperation(operation.id,{status:'conflict',error:message});
    return 'conflict';
  }
  private async send(operation:OutboxOperation):Promise<'sent'|'conflict'> {
    const payload=operation.payload;
    if(payload.kind==='progress') {
      const remote=await this.client.getProgress(payload.anchor);
      if(remote && remote.locator===payload.anchor.locator && remote.fileId===payload.anchor.fileId && Math.abs(remote.progress-payload.anchor.progress)<0.00001) return 'sent';
      if(remote?.updatedAt && Date.parse(remote.updatedAt)>Date.parse(operation.occurredAt)) return this.conflict(operation,'A newer position exists on the server. Choose which position to keep.');
      if(payload.anchor.kind==='audio') await this.client.saveProgress(payload.anchor,{operationId:operation.id});
      else await this.client.saveProgress(payload.anchor);
    } else if(payload.kind==='session') {
      // BookOrbit deduplicates its sessionId, so retry uses the same ID and original times.
      await this.client.saveReadingSession(payload.session,payload.fileId,{endedAt:payload.endedAt});
    } else {
      const annotation=payload.annotation;
      const remote=annotation.kind==='audio'?await this.client.getAudioAnnotations(annotation.bookId,annotation.fileId):await this.client.getAnnotations(annotation.bookId,annotation.fileId);
      let existing=remote.find(a=>a.id===annotation.id);
      if(operation.status==='uncertain'||operation.status==='syncing') {
        const matches=remote.filter(a=>a.fileId===annotation.fileId&&a.locator===annotation.locator&&a.quote===annotation.quote&&a.text===annotation.text&&a.color===annotation.color);
        if(!existing && matches.length===1) {
          await this.repository.acknowledgeAnnotation(annotation.id,matches[0]);
          return 'sent';
        }
        if(!existing && annotation.kind!=='audio' && !/^\d+$/.test(annotation.id)) return this.conflict(operation,'The result of this annotation creation is uncertain. Review server notes before retrying to avoid duplicates.');
      }
      if(existing && existing.updatedAt!==operation.expectedRemoteUpdatedAt && Date.parse(existing.updatedAt)>Date.parse(operation.occurredAt) && !sameAnnotation(existing,annotation)) return this.conflict(operation,'This annotation changed on the server after the local edit.');
      if(annotation.deleted) {
        if(existing) await this.client.deleteAnnotation(annotation.bookId,existing.id,annotation.kind);
      } else if(existing && sameAnnotation(existing,annotation)) {
        await this.repository.acknowledgeAnnotation(annotation.id,existing);
      } else {
        if(/^\d+$/.test(annotation.id)&&!existing) return this.conflict(operation,'The server annotation was deleted. The local note has been preserved.');
        const saved=await this.client.saveAnnotation(annotation);
        await this.repository.acknowledgeAnnotation(annotation.id,saved);
      }
    }
    return 'sent';
  }
}
function sameAnnotation(a:Annotation,b:Annotation):boolean {
  if(a.kind==='audio'&&b.kind==='audio') return Math.abs(audioTimelineSeconds(a.locator)-audioTimelineSeconds(b.locator))<0.001&&a.quote===b.quote&&a.text===b.text;
  return a.locator===b.locator&&a.quote===b.quote&&a.text===b.text&&a.color===b.color;
}
