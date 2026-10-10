import {beforeEach, describe, expect, it, vi} from 'vitest';
const host=vi.hoisted(()=>({native:false,available:false,plugin:{open:vi.fn(),read:vi.fn(),close:vi.fn(),discover:vi.fn()},desktopFetch:null as typeof fetch|null,desktopDiscovery:undefined as unknown}));
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>host.native,isPluginAvailable:(name:string)=>name==='AvidCrossPoint'&&host.available},registerPlugin:()=>host.plugin}));
vi.mock('../../desktop/src/crosspoint',()=>({createDesktopCrossPointFetch:(bridge:typeof host.plugin)=>vi.fn(async()=>bridge.open()),getDesktopCrossPointFetch:()=>host.desktopFetch,getDesktopReaderDiscovery:()=>host.desktopDiscovery}));
import {getCrossPointFetch,getReaderDiscovery} from './native-crosspoint';
describe('installed reader transport selection',()=>{
  beforeEach(()=>{host.native=false;host.available=false;host.desktopFetch=null;host.desktopDiscovery=undefined;vi.clearAllMocks();});
  it('uses browser fetch without advertising native UDP discovery',()=>{expect(getCrossPointFetch()).toBeNull();expect(getReaderDiscovery()).toBeUndefined();});
  it('fails closed when an older mobile host lacks the isolated transport',async()=>{
    host.native=true;
    await expect(getCrossPointFetch()!('http://192.168.1.2/api/status?plugin=avid')).rejects.toThrow('isolated reader transport');
    expect(getReaderDiscovery()).toBeUndefined();expect(host.plugin.open).not.toHaveBeenCalled();
  });
  it('exposes only registered native functions and preserves desktop routing',()=>{
    host.native=true;host.available=true;expect(getCrossPointFetch()).toBeTypeOf('function');expect(getReaderDiscovery()).toBeTypeOf('function');
    const desktop=vi.fn(), discover=vi.fn();host.desktopFetch=desktop;host.desktopDiscovery=discover;
    expect(getCrossPointFetch()).toBe(desktop);expect(getReaderDiscovery()).toBe(discover);
  });
});
