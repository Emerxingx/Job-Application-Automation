/**
 * The device-side store behind the offline cache: one JSON file per key in
 * the app's cache directory (the OS may evict it; that is fine for a cache).
 * The key is the device credential's job, not this file's - nothing under
 * this directory is a secret, and it is wiped on sign-out.
 */
import { Directory, File, Paths } from 'expo-file-system';
import type { CacheStore } from './cache';
import { MemoryStore } from './cache';

const DIR_NAME = 'api-cache';

function fileName(key: string): string {
  // Keys are paths with query strings; encode to one safe segment.
  return encodeURIComponent(key).replace(/%/g, '_') + '.json';
}

export class FileStore implements CacheStore {
  private readonly dir: Directory;

  constructor() {
    this.dir = new Directory(Paths.cache, DIR_NAME);
  }

  private ensure(): void {
    if (!this.dir.exists) this.dir.create({ intermediates: true, idempotent: true });
  }

  async get(key: string): Promise<string | null> {
    try {
      const file = new File(this.dir, fileName(key));
      if (!file.exists) return null;
      return await file.text();
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      this.ensure();
      new File(this.dir, fileName(key)).write(value);
    } catch {
      // A cache that cannot be written is a cache that is empty; never an error to the person.
    }
  }

  async remove(key: string): Promise<void> {
    try {
      const file = new File(this.dir, fileName(key));
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    try {
      if (this.dir.exists) this.dir.delete();
    } catch {
      // ignore
    }
  }
}

/** The file store on a device; memory in a browser tab (no filesystem there, and nothing persists a cache across tabs on purpose). */
export function defaultStore(platform: string): CacheStore {
  return platform === 'web' ? new MemoryStore() : new FileStore();
}
