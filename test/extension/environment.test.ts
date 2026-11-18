import { strict as assert } from 'node:assert';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, isAbsolute } from 'node:path';

/** Set by `.vscode-test.mjs` in its own process and dropped by the allowlist. */
const ENVIRONMENT_SENTINEL = 'VSCODE_DEPLOYMENT_ENVIRONMENT_SENTINEL';

/** Names that usually hold credentials. Only names are ever reported, never values. */
const CREDENTIAL_NAME =
  /TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE|SSH_AUTH_SOCK|^AWS_|^GH_|^GITHUB_|^NPM_/i;

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('environment of the test instance', () => {
  it('does not inherit the variables of the process that started the tests', () => {
    assert.equal(process.env[ENVIRONMENT_SENTINEL], undefined);
  });

  it('has no variable whose name suggests a credential', () => {
    const suspicious = Object.keys(process.env).filter((name) => CREDENTIAL_NAME.test(name));
    assert.deepEqual(suspicious, []);
  });

  it('uses a home directory of the test instance', () => {
    const root = process.env['VSCODE_DEPLOYMENT_TEST_ROOT'];
    assert.ok(root, 'VSCODE_DEPLOYMENT_TEST_ROOT is not set');
    assert.ok(isInside(realpathSync(root), realpathSync(homedir())), 'HOME is not a test folder');
  });
});
