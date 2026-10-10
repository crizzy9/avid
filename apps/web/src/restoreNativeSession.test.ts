import { describe, expect, it, vi } from 'vitest';
import { SessionPersistence } from './sessionPersistence';
import { restoreNativeSession } from './restoreNativeSession';
import type { NativeSessionRecord, NativeSessionVault } from '../../mobile/src/native-session';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});
function fixture() {
  let record: NativeSessionRecord = {generation:'start',readOnly:true,session:{profile:{id:'s',name:'Test',url:'https://books.example'},userId:'7',accessToken:'expired',refreshToken:'old-refresh',clientKind:'native'}};
  const vault: NativeSessionVault = {read:vi.fn(async()=>record),write:vi.fn(async value=>{
    expect(value.expectedGeneration).toBe(record.generation);
    record = {generation:'next',session:value.session,readOnly:value.readOnly}; return record;
  }),clear:vi.fn(async()=>record={generation:'clear'})};
  return {persistence:new SessionPersistence(vault),vault,record:()=>record};
}
describe('native session restoration',()=>{
  it('keeps rotated credentials safe even when the catalog later fails',async()=>{
    const {persistence,record}=fixture();
    const fetcher = vi.fn(async (input: RequestInfo|URL, init?:RequestInit)=>{
      if (String(input).endsWith('/auth/refresh')) return reply({accessToken:'fresh',refreshToken:'rotated'});
      return new Headers(init?.headers).get('Authorization')==='Bearer expired' ? reply({},401) : reply({id:7,username:'reader',active:true});
    });
    const connect = vi.fn(async()=>{
      expect(record().session?.refreshToken).toBe('rotated');
      throw new Error('Catalog temporarily unavailable');
    });
    await expect(restoreNativeSession(persistence,()=>({fetch:fetcher}),connect,()=>true,new AbortController().signal)).rejects.toThrow('Catalog');
    expect(record().session?.accessToken).toBe('fresh');
    expect(record().readOnly).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('does not persist or activate a different authenticated account',async()=>{
    const {persistence,vault}=fixture(); const connect=vi.fn();
    await expect(restoreNativeSession(persistence,()=>({fetch:async()=>reply({id:8,username:'other',active:true})}),connect,()=>true,new AbortController().signal)).rejects.toThrow('saved session');
    expect(vault.write).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
  it('abandons activation when a manual attempt supersedes the identity request',async()=>{
    const {persistence,vault}=fixture(); const connect=vi.fn(); let active=true;
    await restoreNativeSession(persistence,()=>({fetch:async()=>{active=false;return reply({id:7,username:'reader',active:true});}}),connect,()=>active,new AbortController().signal);
    expect(vault.write).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
});
