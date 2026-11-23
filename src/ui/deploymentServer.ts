/**
 * Which server a deployment command (Compare with Deployed Version, upload) uses, without the
 * VS Code API. Only servers that files can be deployed to are considered (SFTP with at least
 * one mapping). One of them marked as default is used without asking; so is the only one.
 * Otherwise the user picks one. Test Connection and Disconnect choose differently (any SFTP
 * server), see `connectionCommands.ts`.
 */
import { posix } from 'node:path';
import { isUploadTarget } from '../config/contextKeys';
import { sanitizeForDisplay } from '../display/sanitize';
import { pathSegments } from '../mapping/paths';
import { labelText } from './connectionPresentation';
import type { SftpServerChoice } from './serverChoices';

export type ServerSelection =
  | { readonly kind: 'chosen'; readonly choice: SftpServerChoice }
  /** Ask the user; `choices` in the given order. */
  | { readonly kind: 'pick'; readonly choices: readonly SftpServerChoice[] }
  /** No server of the given ones can be deployed to. */
  | { readonly kind: 'none' };

export function selectDeploymentServer(choices: readonly SftpServerChoice[]): ServerSelection {
  const targets = choices.filter((choice) => isUploadTarget(choice.server));
  const defaults = targets.filter((choice) => choice.server.default);
  const only = defaults.length === 1 ? defaults[0] : targets.length === 1 ? targets[0] : undefined;
  if (only !== undefined) {
    return { kind: 'chosen', choice: only };
  }
  return targets.length === 0 ? { kind: 'none' } : { kind: 'pick', choices: targets };
}

/** Plain text for a QuickPick description or detail, which render `$(icon)` syntax. */
function pickText(text: string, maxLength: number): string {
  return sanitizeForDisplay(text, { maxLength }).replace(/\$\(/g, '\\$(');
}

/** The QuickPick item of a server: name, host and the paths its mappings deploy to. */
export function deploymentPickItem(choice: SftpServerChoice): {
  label: string;
  description: string;
  detail: string;
} {
  const { server } = choice;
  const paths = server.mappings.map((mapping) =>
    posix.join(server.rootPath, ...pathSegments(mapping.deploymentPath)),
  );
  return {
    label: labelText(server.name),
    description: pickText(server.connection.sshConfigHost ?? server.connection.host ?? '', 100),
    detail: pickText(paths.join(', '), 300),
  };
}
