import { invoke, isTauri } from "@tauri-apps/api/core";
import type { NativeLibraryStorageBridge } from "../../../packages/core/src/storageProtocol";
import { AvidDatabase } from "../../../packages/core/src/repository";
import {
  DexieLibraryStorage,
  type LibraryStorage,
} from "../../../packages/core/src/storage";
import { NativeLibraryStorage } from "../../../packages/core/src/nativeStorage";
import { MigratingLibraryStorage } from "../../../packages/core/src/storageMigration";

const bridge: NativeLibraryStorageBridge = {
  read: (request) => invoke("library_storage_read", { request }),
  commit: (request) => invoke("library_storage_commit", { request }),
  beginBlob: (request) => invoke("library_storage_blob_begin", { request }),
  appendBlob: (request) => invoke("library_storage_blob_append", { request }),
  finishBlob: (request) => invoke("library_storage_blob_finish", { request }),
  readBlob: (request) => invoke("library_storage_blob_read", { request }),
  cancelBlob: (request) => invoke("library_storage_blob_cancel", { request }),
};

export function getDesktopStorageBridge(): NativeLibraryStorageBridge | null {
  return isTauri() ? bridge : null;
}

/** Copy and verify legacy records before the first native account operation; never silently fall back. */
export function createDesktopLibraryStorage(): LibraryStorage | undefined {
  const native = getDesktopStorageBridge();
  return native
    ? new MigratingLibraryStorage(
        new DexieLibraryStorage(new AvidDatabase()),
        new NativeLibraryStorage(native),
      )
    : undefined;
}
