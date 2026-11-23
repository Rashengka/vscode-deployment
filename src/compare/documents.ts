/**
 * The deployed versions shown by Compare with Deployed Version, kept in memory and served by
 * the read-only `vscode-deployment-remote:` file system (`remoteFileSystem.ts`). Kept free of
 * the VS Code API.
 *
 * The file system never reads from a server: it only serves what a Compare command downloaded
 * and registered here. Each registration gets its own random token, and a document is served
 * only at the exact address it was registered with (path and token, nothing else). An address
 * made up by anyone else (another extension, a link) therefore finds nothing.
 *
 * Memory is bounded: at most `maxDocuments` documents and `maxBytes` bytes are kept, the
 * oldest are dropped first; the command drops a document when its last editor tab closes.
 */
import { randomBytes } from 'node:crypto';

export const REMOTE_SCHEME = 'vscode-deployment-remote';

/** The parts of a URI that identify a document. */
export interface RemoteDocumentAddress {
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

export interface RemoteDocument {
  readonly path: string;
  readonly content: Uint8Array;
  /** Modification time on the server, in milliseconds since the epoch. */
  readonly mtimeMs: number;
}

export interface RemoteDocumentsOptions {
  /** A new unguessable token; default 24 random bytes in base64url. */
  readonly token?: () => string;
  readonly maxDocuments?: number;
  readonly maxBytes?: number;
}

const DEFAULT_MAX_DOCUMENTS = 10;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

export class RemoteDocuments {
  /** By token, oldest first. */
  private readonly documents = new Map<string, RemoteDocument>();
  private readonly token: () => string;
  private readonly maxDocuments: number;
  private readonly maxBytes: number;

  constructor(options: RemoteDocumentsOptions = {}) {
    this.token = options.token ?? randomToken;
    this.maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get size(): number {
    return this.documents.size;
  }

  /** Registers a document; the result is the path and query of its address. */
  add(
    path: string,
    content: Uint8Array,
    mtimeMs: number,
  ): { readonly path: string; readonly query: string } {
    const token = this.token();
    this.documents.set(token, { path, content, mtimeMs });
    this.trim(token);
    return { path, query: token };
  }

  /** The document at `address`, or `undefined` when the address was not registered as it is. */
  get(address: RemoteDocumentAddress): RemoteDocument | undefined {
    if (address.authority !== '' || address.fragment !== '') {
      return undefined;
    }
    const document = this.documents.get(address.query);
    return document?.path === address.path ? document : undefined;
  }

  remove(address: RemoteDocumentAddress): void {
    if (this.get(address) !== undefined) {
      this.documents.delete(address.query);
    }
  }

  /** Drops the oldest documents (never `keep`) until both limits hold. */
  private trim(keep: string): void {
    let bytes = 0;
    for (const document of this.documents.values()) {
      bytes += document.content.length;
    }
    for (const [token, document] of this.documents) {
      if (this.documents.size <= this.maxDocuments && bytes <= this.maxBytes) {
        return;
      }
      if (token !== keep) {
        this.documents.delete(token);
        bytes -= document.content.length;
      }
    }
  }
}
