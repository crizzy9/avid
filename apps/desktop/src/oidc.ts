import {invoke,isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import type {NativeOidcPlugin} from '../../mobile/src/native-oidc';
const plugin:NativeOidcPlugin={
  capabilities:()=>invoke('desktop_oidc_capabilities'),
  save:request=>invoke('desktop_oidc_save',{request}),
  take:request=>invoke('desktop_oidc_take',{request}),
  pending:()=>invoke('desktop_oidc_pending'),
  open:request=>invoke('desktop_oidc_open',{request}),
  cancel:(request={})=>invoke('desktop_oidc_cancel',{request}),
  addListener:async(_event,callback)=>{const remove=await listen('avid:desktop-oidc-callback',()=>callback());return {remove:async()=>remove()};},
};
/** Requires the native desktop host. Callback routing never falls back to web sessionStorage. */
export function getDesktopOidc():NativeOidcPlugin|null{return isTauri()?plugin:null;}
