import {invoke,isTauri} from '@tauri-apps/api/core';
import {createDesktopFetch,type DesktopHttpBridge,type DesktopHttpHead} from './network';

export interface DesktopCrossPointBridge {
  open(request:Parameters<DesktopHttpBridge['open']>[0]&{id:string}):Promise<DesktopHttpHead>;
  read:DesktopHttpBridge['read'];
  close:DesktopHttpBridge['close'];
}
const native:DesktopCrossPointBridge={
  open:request=>invoke('desktop_crosspoint_open',{request}),
  read:request=>invoke('desktop_crosspoint_read',{request}),
  close:request=>invoke('desktop_crosspoint_close',{request}),
};
/** A dedicated credential-free native LAN client. Cancellation reaches an in-flight upload. */
export function createDesktopCrossPointFetch(bridge:DesktopCrossPointBridge=native):typeof fetch {
  return createDesktopFetch({
    async open(request,signal){
      const id=crypto.randomUUID();
      const cancel=()=>{void bridge.close({id}).catch(()=>{});};
      signal?.throwIfAborted();
      signal?.addEventListener('abort',cancel,{once:true});
      try {
        const result=await bridge.open({...request,id});
        if(result.id!==id){await bridge.close({id}).catch(()=>{});throw new Error('The native reader response identity changed.');}
        return result;
      }finally{signal?.removeEventListener('abort',cancel);}
    },
    read:request=>bridge.read(request),close:request=>bridge.close(request),
  },64*1024*1024+64*1024);
}
const request=createDesktopCrossPointFetch();
export function getDesktopCrossPointFetch():typeof fetch|null{return isTauri()?request:null;}
