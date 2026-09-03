import { promises as fs } from 'fs';
import path from 'path';
import type { StorageProvider, StoredObject } from './provider';

/** The filesystem provider: the pre-Stage-05 behaviour, unchanged, under the interface. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  readonly location: string;
  constructor(private readonly root = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')) {
    this.location = `filesystem:${this.root}`;
  }
  private resolve(key: string): string {
    const abs = path.resolve(this.root, key);
    // A key can never escape the root, whatever it contains.
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error('storage key escapes the root');
    return abs;
  }
  async put(key: string, body: string): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(key), 'utf8');
    } catch {
      return null;
    }
  }
  async putBytes(key: string, body: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  async getBytes(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }
  async list(prefix: string): Promise<StoredObject[]> {
    try {
      const dir = this.resolve(prefix);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries.filter((e) => e.isFile()).map(async (e) => ({ key: path.posix.join(prefix, e.name), size: (await fs.stat(path.join(dir, e.name))).size })),
      );
      return files.sort((a, b) => a.key.localeCompare(b.key));
    } catch {
      return [];
    }
  }
}
