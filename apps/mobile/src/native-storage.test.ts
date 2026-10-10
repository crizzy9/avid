import {beforeEach,describe,expect,it,vi} from 'vitest';
const host=vi.hoisted(()=>({native:false,available:false,plugin:{read:vi.fn(),commit:vi.fn()},desktop:vi.fn()}));
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>host.native,isPluginAvailable:(name:string)=>name==='AvidLibraryStorage'&&host.available},registerPlugin:(name:string)=>name==='AvidLibraryStorage'?host.plugin:{}}));
vi.mock('../../desktop/src/storage',()=>({createDesktopLibraryStorage:host.desktop}));
import {createPlatformLibraryStorage,getMobileStorageBridge} from './native-storage';
import {MigratingLibraryStorage} from '../../../packages/core/src/storageMigration';
describe('native library storage selection',()=>{
  beforeEach(()=>{host.native=false;host.available=false;host.desktop.mockReset();});
  it('retains browser/desktop routing without pretending that a mobile plugin exists',()=>{
    expect(getMobileStorageBridge()).toBeNull();expect(createPlatformLibraryStorage()).toBeUndefined();expect(host.desktop).toHaveBeenCalledOnce();
    const desktop={name:'desktop'};host.desktop.mockReturnValue(desktop);expect(createPlatformLibraryStorage()).toBe(desktop);
  });
  it('fails storage operations visibly when the installed mobile host lacks the plugin',async()=>{
    host.native=true;const storage=createPlatformLibraryStorage()!;const work=vi.fn();
    await expect(storage.read('["https://demo.avid.invalid","demo"]','books')).rejects.toThrow('Native library storage is unavailable');
    await expect(storage.atomic('["https://demo.avid.invalid","demo"]',['books'],work)).rejects.toThrow('Native library storage is unavailable');
    expect(work).not.toHaveBeenCalled();expect(host.desktop).not.toHaveBeenCalled();
  });
  it('requires the actual registered plugin and wraps it with verified migration',()=>{
    host.native=true;host.available=true;
    expect(getMobileStorageBridge()).toBe(host.plugin);
    expect(createPlatformLibraryStorage()).toBeInstanceOf(MigratingLibraryStorage);
    expect(host.desktop).not.toHaveBeenCalled();
  });
});
