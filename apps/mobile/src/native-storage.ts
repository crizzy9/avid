import {Capacitor,registerPlugin} from '@capacitor/core';
import type {NativeLibraryStorageBridge} from '../../../packages/core/src/storageProtocol';
import {AvidDatabase} from '../../../packages/core/src/repository';
import {DexieLibraryStorage,type LibraryStorage} from '../../../packages/core/src/storage';
import {NativeLibraryStorage} from '../../../packages/core/src/nativeStorage';
import {MigratingLibraryStorage} from '../../../packages/core/src/storageMigration';
import {createDesktopLibraryStorage} from '../../desktop/src/storage';

const plugin=registerPlugin<NativeLibraryStorageBridge>('AvidLibraryStorage');
/** Plugin presence is checked on the actual host; a platform name is not storage evidence. */
export function getMobileStorageBridge():NativeLibraryStorageBridge|null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AvidLibraryStorage') ? plugin : null;
}
const unavailable:LibraryStorage={
  name:'avid-mobile-storage-unavailable',
  async read(){throw new Error('Native library storage is unavailable. Update Avid to continue.');},
  async atomic(){throw new Error('Native library storage is unavailable. Update Avid to continue.');},
};
/** Retain and verify each account's IndexedDB source before publishing its native migration receipt. */
export function createPlatformLibraryStorage():LibraryStorage|undefined {
  if(!Capacitor.isNativePlatform())return createDesktopLibraryStorage();
  const bridge=getMobileStorageBridge();
  return bridge ? new MigratingLibraryStorage(
    new DexieLibraryStorage(new AvidDatabase()),
    new NativeLibraryStorage(bridge,'avid-mobile-library-v1'),
  ) : unavailable;
}
