/**
 * Entries of the `Deployment` output channel: one line per entry, `[<server>] <action>: <detail>`.
 * The channel adds the time.
 *
 * What is written:
 * - Never a passphrase or the content of a key. No caller passes them, and the extension never
 *   holds a passphrase where logging code could reach it. As a second line of defence, anything
 *   that looks like private key material is removed before writing ({@link redactKeyMaterial}).
 * - Text from the server (banners, error messages) only after `sanitizeForDisplay`, on a
 *   single line, so that a server can neither hide text with control characters nor forge
 *   further log entries with line breaks.
 * - For errors only the sanitized message, never the error object (its properties could carry
 *   anything).
 */
import { sanitizeForDisplay } from '../display/sanitize';

/** What the log needs from the output channel (a subset of `vscode.LogOutputChannel`). */
export interface LogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const REMOVED = '[private key removed]';

/*
 * Redaction is a second line of defence only and recognizes key material by its shape: PEM and
 * SSH2 (RFC 4716) armor, the base64 data of an OpenSSH key (it starts with the encoding of
 * `openssh-key-v1`) and PuTTY key files. Base64 key data without its armor or its first line
 * (for example only a later line of an OpenSSH key) is not recognized.
 */

/** PEM private keys of any type, also when the end line is missing (cut-off text). */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/** SSH2 (RFC 4716, ssh.com) private keys, also cut off. */
const SSH2_PRIVATE_KEY =
  /---- BEGIN SSH2 [A-Z0-9 ]*PRIVATE KEY ----[\s\S]*?(?:---- END SSH2 [A-Z0-9 ]*PRIVATE KEY ----|$)/g;
/** The base64 data of an OpenSSH key without its armor (`openssh-key-v1\0`), over line breaks. */
const OPENSSH_KEY_DATA = /b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*(?:(?:\r\n|\r|\n)[A-Za-z0-9+/=]+)*/g;
/** A PuTTY key file, from its first line to the end of the text. */
const PUTTY_KEY_FILE = /PuTTY-User-Key-File-\d+:[\s\S]*/g;

/** Replaces anything that looks like private key material. */
export function redactKeyMaterial(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, REMOVED)
    .replace(SSH2_PRIVATE_KEY, REMOVED)
    .replace(OPENSSH_KEY_DATA, REMOVED)
    .replace(PUTTY_KEY_FILE, REMOVED);
}

function clean(text: string): string {
  return sanitizeForDisplay(redactKeyMaterial(text));
}

export class DeploymentLog {
  private readonly sink: LogSink;

  constructor(sink: LogSink) {
    this.sink = sink;
  }

  info(server: string | undefined, action: string, detail?: string): void {
    this.sink.info(this.format(server, action, detail));
  }

  warn(server: string | undefined, action: string, detail?: string): void {
    this.sink.warn(this.format(server, action, detail));
  }

  error(server: string | undefined, action: string, error: unknown): void {
    // Redacted and sanitized in format(), from the raw message (redaction needs the line breaks).
    const message = error instanceof Error ? error.message : 'Unknown error.';
    this.sink.error(this.format(server, action, message));
  }

  private format(server: string | undefined, action: string, detail: string | undefined): string {
    const prefix = server === undefined ? '' : `[${clean(server)}] `;
    const suffix = detail === undefined || detail === '' ? '' : `: ${clean(detail)}`;
    return `${prefix}${clean(action)}${suffix}`;
  }
}
