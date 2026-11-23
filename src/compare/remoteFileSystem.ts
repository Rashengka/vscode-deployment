/**
 * The read-only `vscode-deployment-remote:` file system: it serves the deployed versions that
 * Compare with Deployed Version registered in {@link RemoteDocuments}, and nothing else. It
 * never reads from a server, so an address made up by anyone (another extension, a link)
 * cannot make it download anything: such an address is simply not found. Every write is an
 * error; VS Code also shows the documents as read-only, because the file system is registered
 * as such.
 */
import * as vscode from 'vscode';
import { REMOTE_SCHEME, type RemoteDocument, type RemoteDocuments } from './documents';

export const READ_ONLY_MESSAGE = 'The deployed version on the server is read-only.';

export class RemoteFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly documents: RemoteDocuments;

  constructor(documents: RemoteDocuments) {
    this.documents = documents;
  }

  /** Registers the file system for {@link REMOTE_SCHEME}. */
  static register(documents: RemoteDocuments): vscode.Disposable {
    const provider = new RemoteFileSystem(documents);
    return vscode.Disposable.from(
      vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, provider, {
        isCaseSensitive: true,
        isReadonly: new vscode.MarkdownString(READ_ONLY_MESSAGE),
      }),
      provider.changes,
    );
  }

  private document(uri: vscode.Uri): RemoteDocument {
    const document = this.documents.get(uri);
    if (document === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return document;
  }

  watch(): vscode.Disposable {
    // The documents never change: each Compare registers a new one.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const document = this.document(uri);
    return {
      type: vscode.FileType.File,
      ctime: document.mtimeMs,
      mtime: document.mtimeMs,
      size: document.content.length,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return this.document(uri).content;
  }

  readDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions(READ_ONLY_MESSAGE);
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions(READ_ONLY_MESSAGE);
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions(READ_ONLY_MESSAGE);
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions(READ_ONLY_MESSAGE);
  }
}
