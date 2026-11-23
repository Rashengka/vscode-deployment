import { describe, expect, it } from 'vitest';
import { RemoteDocuments, type RemoteDocumentAddress } from '../../../src/compare/documents';

function counter(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `token${next}`;
  };
}

const content = new Uint8Array([104, 105]);

function address(path: string, query: string): RemoteDocumentAddress {
  return { authority: '', path, query, fragment: '' };
}

describe('RemoteDocuments', () => {
  it('serves a document only at the address it was registered with', () => {
    const documents = new RemoteDocuments({ token: counter() });
    const added = documents.add('/home/deploy/www/a.php', content, 1000);
    expect(added).toEqual({ path: '/home/deploy/www/a.php', query: 'token1' });
    expect(documents.get(address('/home/deploy/www/a.php', 'token1'))?.content).toBe(content);
  });

  it('refuses a hand-made address: no token, a guessed token, another path', () => {
    const documents = new RemoteDocuments({ token: counter() });
    documents.add('/home/deploy/www/a.php', content, 1000);
    expect(documents.get(address('/home/deploy/www/a.php', ''))).toBeUndefined();
    expect(documents.get(address('/home/deploy/www/a.php', 'token2'))).toBeUndefined();
    expect(documents.get(address('/etc/passwd', 'token1'))).toBeUndefined();
    expect(
      documents.get({ ...address('/home/deploy/www/a.php', 'token1'), authority: 'x' }),
    ).toBeUndefined();
    expect(
      documents.get({ ...address('/home/deploy/www/a.php', 'token1'), fragment: 'x' }),
    ).toBeUndefined();
  });

  it('uses a new random token for every document by default', () => {
    const documents = new RemoteDocuments();
    const first = documents.add('/a', content, 0);
    const second = documents.add('/a', content, 0);
    expect(first.query).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(second.query).not.toBe(first.query);
  });

  it('forgets a removed document', () => {
    const documents = new RemoteDocuments({ token: counter() });
    const added = documents.add('/a', content, 0);
    documents.remove(address(added.path, added.query));
    expect(documents.get(address('/a', 'token1'))).toBeUndefined();
    expect(documents.size).toBe(0);
  });

  it('keeps a bounded number of documents and bytes, dropping the oldest first', () => {
    const documents = new RemoteDocuments({ token: counter(), maxDocuments: 2, maxBytes: 100 });
    documents.add('/a', new Uint8Array(10), 0);
    documents.add('/b', new Uint8Array(10), 0);
    documents.add('/c', new Uint8Array(10), 0);
    expect(documents.get(address('/a', 'token1'))).toBeUndefined();
    expect(documents.get(address('/b', 'token2'))).toBeDefined();
    expect(documents.get(address('/c', 'token3'))).toBeDefined();
    documents.add('/d', new Uint8Array(95), 0);
    // The newest document is always kept, even when it alone is at the byte limit.
    expect(documents.size).toBe(1);
    expect(documents.get(address('/d', 'token4'))).toBeDefined();
  });
});
