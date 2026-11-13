import { describe, expect, it } from 'vitest';
import { remoteWindowRefusal } from '../../../src/ssh/remoteWindow';

describe('remoteWindowRefusal', () => {
  it.each([undefined, ''])('allows connections in a local window (%j)', (remoteName) => {
    expect(remoteWindowRefusal(remoteName)).toBeUndefined();
  });

  it.each(['ssh-remote', 'wsl', 'dev-container', 'codespaces', 'tunnel'])(
    'refuses connections in a %s window and explains why',
    (remoteName) => {
      const message = remoteWindowRefusal(remoteName);
      expect(message).toContain(remoteName);
      expect(message).toContain('remote machine');
      expect(message).toContain('local window');
    },
  );
});
