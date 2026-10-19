import { describe, expect, it, vi } from 'vitest';
import { PlaybackController, PlaybackSession, playbackClock, playbackEngineCapabilities, type AudioElement, type PlaybackBook, type PlaybackEvent, type NativeOwnerEventTail } from '../src';

const book: PlaybackBook = { bookId: 'book', fileId: 'file', manifestRevision: 'edition-1', title: 'Private title', authors: [], tracks: [{id:'one',url:'https://private.invalid/audio?token=secret',duration:120}], chapters:[{id:'c',title:'Chapter',start:60,duration:60}] };
function setup() {
  let scope = 'account';
  const audio = Object.assign(new EventTarget(), {src:'',currentTime:0,duration:120,playbackRate:1,preservesPitch:true,paused:true,ended:false,error:null,preload:'',load:vi.fn(),removeAttribute:vi.fn(),play:vi.fn(async()=>{}),pause:vi.fn()});
  const controller = new PlaybackController({ audio:audio as AudioElement, mediaSession:null, accountScope:()=>scope });
  controller.load(book,30); audio.dispatchEvent(new Event('loadedmetadata'));
  return {controller,audio,account:(next:string)=>{scope=next;}};
}
describe('source clock and live playback command foundation',()=>{
  it('never converts speed estimates into source time or invents processed output measurements',()=>{
    expect(playbackClock({currentTime:100,duration:200,rate:2})).toEqual({version:1,sourceSeconds:100,playbackRate:2,estimatedRemainingWallSeconds:50,processedOutputSeconds:null,processing:'none'});
    expect(playbackClock({currentTime:100,duration:0,rate:1}).estimatedRemainingWallSeconds).toBeNull();
    expect(playbackEngineCapabilities('desktop-webview')).toMatchObject({independentBackgroundOwner:false,processing:false,physicalDeviceQualified:false,gapless:'unqualified'});
    expect(playbackEngineCapabilities('ios-avqueue').independentBackgroundOwner).toBe(true);
  });
  it('records real backward moves and reasons, preserving source identity without URLs or title',async()=>{
    const {controller}=setup(); const events:PlaybackEvent[]=[]; controller.onPlaybackEvent(event=>events.push(event));
    try {
      const expected=controller.getPlaybackSession()!;
      expect(await controller.dispatch({version:1,expected,reason:'read-listen-handoff',action:'seek',sourceSeconds:10})).toBe(true);
      expect(controller.getSnapshot().currentTime).toBe(10);
      expect(events.at(-1)).toMatchObject({kind:'seek',reason:'read-listen-handoff',fromSourceSeconds:30,toSourceSeconds:10,session:{accountScope:'account',manifestRevision:'edition-1'}});
      expect(JSON.stringify(controller.getPlaybackHistory())).not.toMatch(/secret|private.invalid|Private title/);
      const exported=controller.getPlaybackHistory(); exported[0]!.session.fileId='tampered';
      expect(controller.getPlaybackHistory()[0]!.session.fileId).toBe('file');
    } finally {controller.destroy();}
  });
  it('rejects commands after source reload, edition change, account change and destroy',async()=>{
    const {controller,account}=setup(); const expected=controller.getPlaybackSession()!;
    const command={version:1 as const,expected,reason:'user-seek' as const,action:'seek' as const,sourceSeconds:90};
    controller.load(book,20);
    expect(await controller.dispatch(command)).toBe(false);
    const reloaded=controller.getPlaybackSession()!;
    controller.load({...book,manifestRevision:'edition-2'},40);
    expect(await controller.dispatch({...command,expected:reloaded})).toBe(false);
    const edition=controller.getPlaybackSession()!; account('other');
    expect(await controller.dispatch({...command,expected:edition})).toBe(false);
    expect(controller.getPlaybackSession()).toBeNull(); expect(controller.getPlaybackHistory()).toEqual([]); expect(controller.checkpoint()).toBeNull();
    controller.destroy(); expect(await controller.dispatch(command)).toBe(false);
  });
  it('ignores nonfinite seek/rate commands instead of corrupting locators',async()=>{
    const {controller}=setup();try{
      controller.seek(NaN);controller.setRate(Infinity);
      const expected=controller.getPlaybackSession()!;
      expect(await controller.dispatch({version:1,expected,reason:'user-seek',action:'seek',sourceSeconds:NaN})).toBe(false);
      expect(controller.getSnapshot()).toMatchObject({currentTime:30,rate:1});
    } finally {controller.destroy();}
  });
  it('retains only 256 events and isolates observers from playback commands',()=>{
    const {controller}=setup();try{
      controller.onPlaybackEvent(()=>{throw new Error('observer broke');});
      for(let i=0;i<300;i++) controller.seek(i%100);
      const history=controller.getPlaybackHistory();
      expect(history).toHaveLength(256); expect(history[0]!.sequence).toBe(46); expect(history.at(-1)!.sequence).toBe(301);
      controller.load(book);expect(controller.getPlaybackHistory()).toHaveLength(1);
    } finally {controller.destroy();}
  });
  it('replays bounded native owner observations once, with exact source and revision checks',()=>{
    const {controller}=setup();try{
      const session=new PlaybackSession();session.bind(book,'account');
      const event={sequence:1,kind:'seek' as const,reason:'remote' as const,observedAt:'2026-10-19T00:00:00.000Z',fromSourceSeconds:90,toSourceSeconds:60,rate:2,status:'paused' as const};
      const tail:NativeOwnerEventTail={version:1,accountScope:'account',bookId:'book',fileId:'file',manifestRevision:'edition-1',ownerId:'native-process-load',events:[event]};
      session.importNative(tail,'account');session.importNative(tail,'account');
      expect(session.events('account')).toHaveLength(1);
      expect(session.events('account')[0]).toMatchObject({origin:'native-owner',reason:'remote',fromSourceSeconds:90,toSourceSeconds:60,observedAt:event.observedAt});
      session.importNative({...tail,manifestRevision:'wrong',events:[{...event,sequence:2}]},'account');
      session.importNative({...tail,events:[{...event,sequence:2,toSourceSeconds:NaN}]},'account');
      session.importNative({...tail,events:[{...event,sequence:3},{...event,sequence:2}]},'account');
      expect(session.events('account')).toHaveLength(1);
      session.importNative({...tail,events:[event,{...event,sequence:2,reason:'sleep'}]},'account');
      expect(session.events('account')).toHaveLength(2);
      session.bind({...book,manifestRevision:'edition-2'},'account');session.importNative(tail,'account');
      expect(session.events('account')).toEqual([]);
    } finally {controller.destroy();}
  });
  it('binds each owner token independently even for identical book and account ids',()=>{
    const one=setup();const two=setup();try{
      expect(one.controller.getPlaybackSession()!.sessionId).not.toBe(two.controller.getPlaybackSession()!.sessionId);
      const session=new PlaybackSession();session.bind(book,'account');
      expect(session.matches(one.controller.getPlaybackSession()!,'account')).toBe(false);
    } finally {one.controller.destroy();two.controller.destroy();}
  });
});
