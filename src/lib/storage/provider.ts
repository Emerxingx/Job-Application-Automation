/**
 * Object storage behind the application folders (ADR-0015: "object storage
 * replaces local filesystem"). The provider pattern the rest of the codebase
 * uses: an interface, a local default that needs no configuration, a real
 * adapter loaded lazily and selected by environment variable with
 * warn-and-degrade.
 *
 * Keys are POSIX-style relative paths (`<userId>/applications/<month>/<folder>/<file>`).
 * Nothing here knows what a file means; `index.ts` does.
 */
export interface StoredObject {
  key: string;
  size: number;
}

export interface StorageProvider {
  readonly name: string;
  /** Where the bytes live, for the register — never a credential. */
  readonly location: string;
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Stage 09: binary documents (PDF, DOCX) with their content type. */
  putBytes(key: string, body: Buffer, contentType: string): Promise<void>;
  getBytes(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<StoredObject[]>;
}
