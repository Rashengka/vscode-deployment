import { describe, expect, it } from 'vitest';
import {
  ConnectionAttemptEndedError,
  MAX_PASSPHRASE_ATTEMPTS,
  PassphraseCancelledError,
  TooManyPassphraseAttemptsError,
  serializePrompts,
  withPassphrase,
  type PassphraseRequest,
} from '../../../src/ssh/passphrase';
import { WrongPassphraseError } from '../../../src/ssh/privateKey';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function request(keyFile: string, signal = new AbortController().signal): PassphraseRequest {
  return {
    keyFile,
    target: 'deploy@example.com:22',
    attempt: 1,
    maxAttempts: 3,
    previousAttemptFailed: false,
    signal,
  };
}

describe('serializePrompts', () => {
  it('shows at most one prompt at a time, in request order', async () => {
    const gates = [deferred<Buffer | undefined>(), deferred<Buffer | undefined>()];
    const shown: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const prompt = serializePrompts(async (shownRequest) => {
      shown.push(shownRequest.keyFile);
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      const answer = await gates[shown.length - 1]?.promise;
      open -= 1;
      return answer;
    });

    const first = prompt(request('/home/deploy/.ssh/a'));
    const second = prompt(request('/home/deploy/.ssh/b'));
    await tick();
    expect(shown).toEqual(['/home/deploy/.ssh/a']);

    gates[0]?.resolve(Buffer.from('x'));
    await first;
    await tick();
    expect(shown).toEqual(['/home/deploy/.ssh/a', '/home/deploy/.ssh/b']);
    gates[1]?.resolve(undefined);
    await expect(second).resolves.toBeUndefined();
    expect(maxOpen).toBe(1);
  });

  it('keeps going after a prompt fails', async () => {
    let calls = 0;
    const prompt = serializePrompts(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('closed')) : Promise.resolve(undefined);
    });
    await expect(prompt(request('k'))).rejects.toThrow('closed');
    await expect(prompt(request('k'))).resolves.toBeUndefined();
  });

  it('lets the next prompt through when an unanswered prompt is aborted', async () => {
    const shown: string[] = [];
    const prompt = serializePrompts((shownRequest) => {
      shown.push(shownRequest.keyFile);
      // The first prompt is never answered, like an input box the user ignores.
      return shownRequest.keyFile === 'first'
        ? new Promise<Buffer | undefined>(() => undefined)
        : Promise.resolve(undefined);
    });
    const abort = new AbortController();

    const first = prompt(request('first', abort.signal));
    const second = prompt(request('second'));
    await tick();
    expect(shown).toEqual(['first']);

    abort.abort();
    await expect(first).rejects.toBeInstanceOf(ConnectionAttemptEndedError);
    await expect(second).resolves.toBeUndefined();
    expect(shown).toEqual(['first', 'second']);
  });

  it('never shows a request that was aborted while it waited', async () => {
    const gate = deferred<Buffer | undefined>();
    const shown: string[] = [];
    const prompt = serializePrompts((shownRequest) => {
      shown.push(shownRequest.keyFile);
      return gate.promise;
    });
    const abort = new AbortController();

    const first = prompt(request('first'));
    const waiting = prompt(request('waiting', abort.signal));
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(ConnectionAttemptEndedError);
    gate.resolve(undefined);
    await first;
    await tick();
    expect(shown).toEqual(['first']);
  });

  it('passes the signal to the prompt and overwrites a passphrase that arrives too late', async () => {
    const late = deferred<Buffer | undefined>();
    let seen: AbortSignal | undefined;
    const prompt = serializePrompts((shownRequest) => {
      seen = shownRequest.signal;
      return late.promise;
    });
    const abort = new AbortController();
    const pending = prompt(request('k', abort.signal));
    await tick();
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(ConnectionAttemptEndedError);
    expect(seen?.aborted).toBe(true);

    const buffer = Buffer.from('typed-too-late');
    late.resolve(buffer);
    await tick();
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});

describe('withPassphrase', () => {
  const keyFile = '/home/deploy/.ssh/id_ed25519';
  const signal = new AbortController().signal;

  it('retries a wrong passphrase and overwrites every passphrase buffer', async () => {
    const given: Buffer[] = [];
    const requests: PassphraseRequest[] = [];
    const result = await withPassphrase(
      (shownRequest) => {
        requests.push(shownRequest);
        const buffer = Buffer.from(`try-${shownRequest.attempt}`);
        given.push(buffer);
        return Promise.resolve(buffer);
      },
      keyFile,
      'deploy@example.com:22',
      signal,
      (passphrase: Buffer) => {
        if (passphrase.toString() !== 'try-3') {
          return Promise.reject(new WrongPassphraseError(keyFile));
        }
        return Promise.resolve('unlocked');
      },
    );

    expect(result).toBe('unlocked');
    expect(requests.map((shown) => [shown.attempt, shown.previousAttemptFailed])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(given).toHaveLength(3);
    for (const buffer of given) {
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
  });

  it(`stops after ${MAX_PASSPHRASE_ATTEMPTS} wrong passphrases`, async () => {
    let prompts = 0;
    await expect(
      withPassphrase(
        () => {
          prompts += 1;
          return Promise.resolve(Buffer.from('wrong'));
        },
        keyFile,
        't',
        signal,
        () => Promise.reject(new WrongPassphraseError(keyFile)),
      ),
    ).rejects.toBeInstanceOf(TooManyPassphraseAttemptsError);
    expect(prompts).toBe(MAX_PASSPHRASE_ATTEMPTS);
  });

  it('stops when the prompt is cancelled', async () => {
    await expect(
      withPassphrase(
        () => Promise.resolve(undefined),
        keyFile,
        't',
        signal,
        () => Promise.resolve(1),
      ),
    ).rejects.toBeInstanceOf(PassphraseCancelledError);
  });

  it('does not ask at all once the connection attempt has ended', async () => {
    const abort = new AbortController();
    abort.abort();
    let prompts = 0;
    await expect(
      withPassphrase(
        () => {
          prompts += 1;
          return Promise.resolve(Buffer.from('x'));
        },
        keyFile,
        't',
        abort.signal,
        () => Promise.resolve(1),
      ),
    ).rejects.toBeInstanceOf(ConnectionAttemptEndedError);
    expect(prompts).toBe(0);
  });

  it('does not retry other errors and still overwrites the passphrase', async () => {
    const buffer = Buffer.from('secret-ish');
    let prompts = 0;
    await expect(
      withPassphrase(
        () => {
          prompts += 1;
          return Promise.resolve(buffer);
        },
        keyFile,
        't',
        signal,
        () => Promise.reject(new Error('unsupported key')),
      ),
    ).rejects.toThrow('unsupported key');
    expect(prompts).toBe(1);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});
