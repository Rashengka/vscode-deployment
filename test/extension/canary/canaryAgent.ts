/**
 * The helper process of the secret leak test (see `secretLeak.test.ts`). It runs outside VS Code
 * and is the only process of the test that knows the canary passphrase, so that the heap of the
 * extension host can be searched for it: the test code in the extension host never sees it.
 *
 * It
 * - creates the canary passphrase and an ed25519 key encrypted with it (ssh-keygen in the test
 *   SSH server's container) and writes the key into the test instance's `~/.ssh`;
 * - types the passphrase into VS Code's real password input box, through the Chrome DevTools
 *   protocol of the test instance (`--remote-debugging-port`);
 * - searches files for the passphrase in several encodings and for the decrypted key, and
 *   proves on its own control files that the search finds what it looks for.
 *
 * Requests and answers are JSON lines on stdin and stdout. Answers never contain the passphrase
 * or key material, only names of encodings, file paths and counts.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface Needle {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface CategoryReport {
  readonly files: number;
  readonly bytes: number;
  readonly lines: number;
  /** `<needle> in <file>` for every match. */
  readonly hits: readonly string[];
  /** Files that could not be read (named, so that a gap is never silent). */
  readonly unreadable: readonly string[];
}

export type AgentRequest =
  | {
      readonly command: 'prepare';
      readonly container: string;
      readonly keyFile: string;
      readonly allowedRoot: string;
      readonly ssh2Bundle: string;
      /**
       * An unencrypted test key that the test keeps parsed in the extension host while it takes
       * a heap snapshot: the positive control for the search for the decrypted key.
       */
      readonly controlKey: string;
    }
  | { readonly command: 'type'; readonly devToolsActivePort: string; readonly timeoutMs: number }
  | { readonly command: 'control'; readonly dir: string }
  | {
      readonly command: 'scan';
      readonly categories: Readonly<Record<string, readonly string[]>>;
      /** Also look for the decrypted key and for the control key. */
      readonly includeKey: boolean;
      /** A text that must be found in every category (positive control for heap snapshots). */
      readonly marker?: string;
      /** Further texts to look for (not secret; reported by name). */
      readonly texts?: readonly { readonly name: string; readonly text: string }[];
    };

let canary: string | undefined;
/** Lines of the decrypted key as ssh2 holds it (PKCS#8 PEM). */
let keyLines: string[] = [];
/** The same for the control key. */
let controlKeyLines: string[] = [];
/**
 * The 32-byte ed25519 private keys (of the canary key and of the control key). They also appear
 * inside OpenSSH key text, which the extension rebuilds from the decrypted key data before ssh2
 * parses it.
 */
let keySeed: Buffer | undefined;
let controlKeySeed: Buffer | undefined;

/**
 * Pieces of base64(prefix + data) for each alignment, 16 characters long and 4 apart: OpenSSH
 * key text wraps its base64 every 70 characters, so the whole encoding may not be on one line,
 * but one of these pieces always is.
 */
function wrappedBase64Needles(name: string, data: Buffer): Needle[] {
  const needles: Needle[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), data]).toString('base64');
    const stable = encoded.slice(
      Math.ceil(offset / 3) * 4,
      Math.floor((offset + data.length) / 3) * 4,
    );
    for (let start = 0; start + 16 <= stable.length; start += 4) {
      needles.push({
        name: `${name} base64 (offset ${offset}, piece ${start / 4 + 1})`,
        bytes: Buffer.from(stable.slice(start, start + 16)),
      });
    }
  }
  return needles;
}

function seedNeedles(name: string, seed: Buffer | undefined): Needle[] {
  return seed === undefined
    ? []
    : [
        ...wrappedBase64Needles(name, seed),
        { name: `${name} hex`, bytes: Buffer.from(seed.toString('hex')) },
      ];
}

/** The seed of an ed25519 key from its PKCS#8 PEM lines (16-byte header, 32-byte seed). */
function ed25519Seed(lines: readonly string[]): Buffer {
  const der = Buffer.from(lines.join(''), 'base64');
  if (der.length !== 48) {
    throw new Error('Unexpected form of a decrypted ed25519 key.');
  }
  return der.subarray(16);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The substring of base64(prefix + data) that depends on `data` only, for each alignment. */
function base64Needles(name: string, data: Buffer): Needle[] {
  const needles: Needle[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), data]).toString('base64');
    const start = Math.ceil(offset / 3) * 4;
    const end = Math.floor((offset + data.length) / 3) * 4;
    const stable = encoded.slice(start, end);
    needles.push({ name: `${name} base64 (offset ${offset})`, bytes: Buffer.from(stable) });
    needles.push({
      name: `${name} base64url (offset ${offset})`,
      bytes: Buffer.from(stable.replace(/\+/g, '-').replace(/\//g, '_')),
    });
  }
  return needles;
}

/** The passphrase in every encoding the test searches for. */
function canaryNeedles(secret: string): Needle[] {
  const utf8 = Buffer.from(secret, 'utf8');
  return [
    { name: 'passphrase utf8', bytes: utf8 },
    { name: 'passphrase utf16le', bytes: Buffer.from(secret, 'utf16le') },
    ...base64Needles('passphrase', utf8),
    { name: 'passphrase hex', bytes: Buffer.from(utf8.toString('hex')) },
    { name: 'passphrase HEX', bytes: Buffer.from(utf8.toString('hex').toUpperCase()) },
    { name: 'passphrase URL-encoded', bytes: Buffer.from(encodeURIComponent(secret)) },
    {
      name: 'passphrase form-encoded',
      bytes: Buffer.from(new URLSearchParams({ v: secret }).toString().slice(2)),
    },
  ];
}

function keyNeedles(): Needle[] {
  return [
    ...seedNeedles('decrypted key seed', keySeed),
    ...seedNeedles('control key seed', controlKeySeed),
    ...keyLines.map((line, index) => ({
      name: `decrypted key line ${index + 1}`,
      bytes: Buffer.from(line),
    })),
    ...controlKeyLines.map((line, index) => ({
      name: `control key line ${index + 1}`,
      bytes: Buffer.from(line),
    })),
  ];
}

/** The base64 lines of the PEM form ssh2 builds for a parsed private key. */
function pemLines(pem: string): string[] {
  return pem.split('\n').filter((line) => line.length >= 20 && !line.startsWith('-----'));
}

function requireCanary(): string {
  if (canary === undefined) {
    throw new Error('prepare was not called');
  }
  return canary;
}

async function prepare(request: Extract<AgentRequest, { command: 'prepare' }>): Promise<object> {
  const root = realpathSync(request.allowedRoot);
  if (!isInside(root, realpathSync(dirname(request.keyFile)))) {
    throw new Error('The key file must be inside the test instance.');
  }
  // Characters that differ in every searched encoding (space, %, +, /, &, =).
  canary = `canary ${randomBytes(12).toString('hex')} %+/&=`;
  const file = '/run/test-canary/id_canary';
  // The passphrase reaches ssh-keygen through the environment only (`-e PASSPHRASE`).
  await execFileAsync(
    'docker',
    [
      'exec',
      '-e',
      'PASSPHRASE',
      request.container,
      'sh',
      '-c',
      `install -d -m 0700 /run/test-canary && ssh-keygen -q -t ed25519 -a 16 -C canary -N "$PASSPHRASE" -f ${file} && cat ${file}.pub >> /home/deploy/.ssh/authorized_keys`,
    ],
    { env: { ...process.env, PASSPHRASE: canary } },
  );
  const { stdout: key } = await execFileAsync('docker', ['exec', request.container, 'cat', file], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  });
  writeFileSync(request.keyFile, key, { mode: 0o600 });

  // The decrypted key as ssh2 represents it, to look for it later.
  const ssh2 = createRequire(request.ssh2Bundle)(request.ssh2Bundle) as {
    utils: {
      parseKey(data: Buffer, passphrase?: string): { getPrivatePEM(): string } | Error;
    };
  };
  const withoutPassphrase = ssh2.utils.parseKey(key);
  const parsed = ssh2.utils.parseKey(key, canary);
  if (parsed instanceof Error) {
    throw new Error('The generated key cannot be decrypted with its passphrase.');
  }
  keyLines = pemLines(parsed.getPrivatePEM());
  keySeed = ed25519Seed(keyLines);
  const control = ssh2.utils.parseKey(Buffer.from(request.controlKey));
  if (control instanceof Error) {
    throw new Error('The control key cannot be parsed.');
  }
  controlKeyLines = pemLines(control.getPrivatePEM());
  controlKeySeed = ed25519Seed(controlKeyLines);
  return {
    encrypted: withoutPassphrase instanceof Error,
    keyLines: keyLines.length,
    controlKeyLines: controlKeyLines.length,
  };
}

interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) {
        return;
      }
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        waiting?.reject(new Error(`DevTools protocol error: ${message.error.message}`));
      } else {
        waiting?.resolve(message.result);
      }
    });
  }

  static async open(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('Cannot connect to the DevTools protocol of the test instance.'));
      });
    });
    return new Cdp(socket);
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    return result.result?.value;
  }

  close(): void {
    this.socket.close();
  }
}

/** Focuses the visible password box of VS Code's quick input, if there is one. */
const FOCUS_PASSWORD_BOX = `(() => {
  const widget = document.querySelector('.quick-input-widget');
  if (!widget || widget.style.display === 'none') return false;
  const input = widget.querySelector('input[type="password"]');
  if (!input || input.offsetParent === null) return false;
  input.focus();
  return document.activeElement === input;
})()`;

async function typePassphrase(
  request: Extract<AgentRequest, { command: 'type' }>,
): Promise<object> {
  const secret = requireCanary();
  const deadline = Date.now() + request.timeoutMs;
  let port: string | undefined;
  while (port === undefined) {
    try {
      port = readFileSync(request.devToolsActivePort, 'utf8').split('\n')[0]?.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (port === undefined || port === '') {
      port = undefined;
      if (Date.now() > deadline) {
        throw new Error('The test instance did not open a DevTools port.');
      }
      await delay(200);
    }
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as CdpTarget[];
  const workbench = targets.find(
    (target) =>
      target.type === 'page' &&
      target.url.includes('workbench') &&
      target.webSocketDebuggerUrl !== undefined,
  );
  if (workbench?.webSocketDebuggerUrl === undefined) {
    throw new Error(`No workbench page among ${targets.length} DevTools targets.`);
  }
  const cdp = await Cdp.open(workbench.webSocketDebuggerUrl);
  try {
    let polls = 0;
    while ((await cdp.evaluate(FOCUS_PASSWORD_BOX)) !== true) {
      polls += 1;
      if (Date.now() > deadline) {
        throw new Error('No password input box appeared in the test instance.');
      }
      await delay(100);
    }
    await cdp.send('Input.insertText', { text: secret });
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    return { typed: true, polls };
  } finally {
    cdp.close();
  }
}

function filesBelow(path: string, unreadable: string[]): string[] {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    unreadable.push(path);
    return [];
  }
  if (stats.isFile()) {
    return [path];
  }
  if (!stats.isDirectory()) {
    // Sockets, pipes and links are not followed or read.
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    unreadable.push(path);
    return [];
  }
  return entries.flatMap((entry) => filesBelow(join(path, entry), unreadable));
}

function scanCategory(paths: readonly string[], needles: readonly Needle[]): CategoryReport {
  const unreadable: string[] = [];
  const hits: string[] = [];
  let files = 0;
  let bytes = 0;
  let lines = 0;
  for (const file of paths.flatMap((path) => filesBelow(path, unreadable))) {
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch {
      unreadable.push(file);
      continue;
    }
    files += 1;
    bytes += content.length;
    for (let index = content.indexOf(10); index !== -1; index = content.indexOf(10, index + 1)) {
      lines += 1;
    }
    for (const needle of needles) {
      if (content.includes(needle.bytes)) {
        hits.push(`${needle.name} in ${file}`);
      }
    }
  }
  return { files, bytes, lines, hits, unreadable };
}

function scan(request: Extract<AgentRequest, { command: 'scan' }>): object {
  const needles = [...canaryNeedles(requireCanary()), ...(request.includeKey ? keyNeedles() : [])];
  const marker =
    request.marker === undefined ? [] : [{ name: 'marker', bytes: Buffer.from(request.marker) }];
  const texts = (request.texts ?? []).map(({ name, text }) => ({
    name,
    bytes: Buffer.from(text),
  }));
  const reports: Record<string, CategoryReport> = {};
  for (const [name, paths] of Object.entries(request.categories)) {
    reports[name] = scanCategory(paths, [...needles, ...marker, ...texts]);
  }
  return reports;
}

/**
 * Writes one control file per encoding (the passphrase between random bytes) and one file
 * without it, and reports which needles the search finds in which file.
 */
function control(request: Extract<AgentRequest, { command: 'control' }>): object {
  const needles = canaryNeedles(requireCanary());
  mkdirSync(request.dir, { recursive: true, mode: 0o700 });
  const expected: Record<string, string> = {};
  needles.forEach((needle, index) => {
    const file = join(request.dir, `control-${index}.bin`);
    writeFileSync(
      file,
      Buffer.concat([randomBytes(1000 + index), needle.bytes, randomBytes(777)]),
      { mode: 0o600 },
    );
    expected[needle.name] = file;
  });
  writeFileSync(join(request.dir, 'clean.bin'), randomBytes(4096), { mode: 0o600 });
  const report = scanCategory([request.dir], needles);
  const missed = Object.entries(expected)
    .filter(([name, file]) => !report.hits.includes(`${name} in ${file}`))
    .map(([name]) => name);
  const falseHits = report.hits.filter((hit) => hit.endsWith(join(request.dir, 'clean.bin')));
  return { needles: needles.length, found: report.hits.length, missed, falseHits };
}

async function handle(request: AgentRequest): Promise<object> {
  switch (request.command) {
    case 'prepare':
      return prepare(request);
    case 'type':
      return typePassphrase(request);
    case 'control':
      return control(request);
    case 'scan':
      return scan(request);
  }
}

const input = createInterface({ input: process.stdin });
let queue = Promise.resolve();
input.on('line', (line) => {
  queue = queue.then(async () => {
    let answer: object;
    try {
      answer = { ok: true, result: await handle(JSON.parse(line) as AgentRequest) };
    } catch (error) {
      // Messages of this file and of docker; none of them contains the passphrase.
      answer = { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
});
input.on('close', () => {
  void queue.then(() => {
    process.exit(0);
  });
});
