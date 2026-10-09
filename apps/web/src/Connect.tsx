import { useState, type FormEvent } from 'react';
import { BookOpen, Server, ArrowRight, ShieldCheck, LoaderCircle } from 'lucide-react';
import { BookOrbitClient } from '../../../packages/core/src/bookorbit';
import type { Session } from '../../../packages/core/src/types';

export function Connect({onConnect}:{onConnect:(session:Session,readOnly:boolean)=>Promise<void>}) {
  const [url,setUrl]=useState(''); const [username,setUsername]=useState(''); const [password,setPassword]=useState('');
  const [readOnly,setReadOnly]=useState(true);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');try{
    const serverUrl=/^https?:\/\//i.test(url)?url:`https://${url}`;
    const profile={id:crypto.randomUUID(),name:new URL(serverUrl).hostname,url:serverUrl,username};
    const session=await BookOrbitClient.login(profile,password,{readOnly,fetch:bookOrbitFetch,transportBaseUrl:proxyBaseFor(serverUrl)});
    setPassword('');await onConnect(session,readOnly);
  }catch(err){setError(err instanceof TypeError?'Could not reach this server. Check its address and CORS configuration, or use the local BookOrbit proxy.':err instanceof Error?err.message:'Connection failed.');}finally{setBusy(false);}}
  return <form className="connect-form" onSubmit={submit}>
    <div className="connect-emblem"><BookOpen size={30}/></div><h3>Your library. Right here.</h3><p>Connect your BookOrbit server to bring your books, listening, and notes together.</p>
    <label>Server address<div className="input-icon"><Server size={17}/><input required type="text" inputMode="url" autoComplete="url" placeholder="https://books.example.com" value={url} onChange={e=>setUrl(e.target.value)}/></div></label>
    <label>Username<input required autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="Your BookOrbit username"/></label>
    <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Your password"/></label>
    <label className="checkbox-label"><input type="checkbox" checked={readOnly} onChange={e=>setReadOnly(e.target.checked)}/> Read-only connection</label><p className="field-hint">Read-only mode keeps all reading progress and notes on this device. It cannot change your server’s library.</p>
    {error&&<div className="error-banner" role="alert">{error}</div>}
    <button className="primary-button full-width" disabled={busy} type="submit">{busy?<LoaderCircle size={17} className="spin"/>:<ArrowRight size={17}/>} {busy?'Connecting…':'Connect to BookOrbit'}</button>
    <p className="privacy-note"><ShieldCheck size={15}/> Direct to your server. Credentials stay out of book content.</p>
  </form>;
}

/** The development proxy is optional and only forwards to the explicitly configured server. */
export const bookOrbitFetch:typeof fetch = (input,init)=>{
  const configured=import.meta.env.VITE_BOOKORBIT_PROXY_ORIGIN as string|undefined;
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(configured&&url.startsWith(`${configured.replace(/\/$/,'')}/api/v1/`))return fetch(`/bookorbit${new URL(url).pathname}${new URL(url).search}`,init);
  return fetch(input,init);
};

export function proxyBaseFor(serverUrl:string):string|undefined {
  const configured=import.meta.env.VITE_BOOKORBIT_PROXY_ORIGIN as string|undefined;
  return configured&&serverUrl.replace(/\/$/,'')===configured.replace(/\/$/,'')?'/bookorbit':undefined;
}
