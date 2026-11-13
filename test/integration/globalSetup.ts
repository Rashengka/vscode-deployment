/**
 * Packages the extension once for the whole integration run and unpacks it into a temporary
 * directory outside the repository, so that tests load the shipped bundle and Node.js cannot
 * resolve anything from the development `node_modules`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { packageVsix, unpackVsix } from '../../scripts/lib/vsix.mts';

declare module 'vitest' {
  export interface ProvidedContext {
    vsixFile: string;
    unpackedExtension: string;
  }
}

export default function setup(project: TestProject): () => void {
  const workDir = mkdtempSync(join(tmpdir(), 'vscode-deployment-it-'));
  const vsixFile = join(workDir, 'vscode-deployment.vsix');
  let unpackedExtension: string;
  try {
    packageVsix(vsixFile);
    unpackedExtension = unpackVsix(vsixFile, join(workDir, 'unpacked'));
  } catch (error) {
    // Teardown is not called when setup fails, so remove the temporary directory here.
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }

  project.provide('vsixFile', vsixFile);
  project.provide('unpackedExtension', unpackedExtension);

  return () => {
    rmSync(workDir, { recursive: true, force: true });
  };
}
