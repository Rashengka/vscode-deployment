/**
 * The extension host side of one remote folder picker: which folders it may list. Without the
 * VS Code API and without a connection (the controller lists through the connection manager).
 *
 * The webview asks for folders by a path relative to the picker's base folder. That path is
 * untrusted, so a folder is listed only when every segment of it is a directory this picker has
 * listed itself (the server reports entries without following symbolic links): never a parent
 * of the base, never a symbolic link, never a name that could not be part of a configured path,
 * and at most {@link MAX_REMOTE_DEPTH} levels deep.
 */
import { posix } from 'node:path';
import { hasInvisibleCharacters, sanitizeForDisplay } from '../display/sanitize';
import type { RemoteEntryType, RemoteListing } from '../transport/deploymentTarget';
import { MAX_REMOTE_DEPTH, type RemoteEntryView } from './protocol';

const MAX_NAME_LENGTH = 255;

/** Whether a name from the server can be a segment of a configured path. */
export function isUsableName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name.length <= MAX_NAME_LENGTH &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !hasInvisibleCharacters(name)
  );
}

const KIND_ORDER: Readonly<Record<RemoteEntryType, number>> = {
  directory: 0,
  symlink: 1,
  file: 2,
  other: 3,
};

export class RemoteBrowser {
  /** Random token that names this picker in the messages of the webview. */
  readonly session: string;
  /** Absolute path of the base folder on the server. */
  readonly base: string;
  /** Folder (relative to the base) -> the types of its entries, by name. */
  private readonly folders = new Map<string, Map<string, RemoteEntryType>>();

  constructor(base: string, session: string) {
    this.base = base;
    this.session = session;
  }

  /** The absolute path of a folder this picker may list, or `null`. */
  folderPath(relative: string): string | null {
    if (relative === '') {
      return this.base;
    }
    const segments = relative.split('/');
    if (segments.length > MAX_REMOTE_DEPTH) {
      return null;
    }
    let parent = '';
    for (const segment of segments) {
      if (!isUsableName(segment) || this.folders.get(parent)?.get(segment) !== 'directory') {
        return null;
      }
      parent = parent === '' ? segment : `${parent}/${segment}`;
    }
    return posix.join(this.base, ...segments);
  }

  /** Remembers what a folder holds and gives its entries for the webview, sorted. */
  record(relative: string, listing: RemoteListing): RemoteEntryView[] {
    const types = new Map<string, RemoteEntryType>();
    for (const entry of listing.entries) {
      if (!types.has(entry.name)) {
        types.set(entry.name, entry.type);
      }
    }
    this.folders.set(relative, types);
    return [...types]
      .sort(([nameA, a], [nameB, b]) => KIND_ORDER[a] - KIND_ORDER[b] || compareNames(nameA, nameB))
      .map(([name, kind]) => {
        const usable = isUsableName(name);
        // A name that cannot be part of a path is not sent back to the webview at all.
        return {
          name: usable ? name : '',
          label: sanitizeForDisplay(name, { maxLength: MAX_NAME_LENGTH }),
          kind,
          usable,
        };
      });
  }
}

function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
