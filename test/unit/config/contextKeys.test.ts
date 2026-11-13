import { describe, expect, it } from 'vitest';
import { computeContextKeys } from '../../../src/config/contextKeys';
import type { DeploymentConfig, Server } from '../../../src/config/model';
import type { LoadResult } from '../../../src/config/store';
import { PROJECT, inplaceServer, sftpServer } from './fixtures';

function ok(servers: Server[]): LoadResult {
  const config: DeploymentConfig = { version: 1, projectPath: PROJECT, servers };
  return { status: 'ok', dir: '/srv/config/projects/-var-www-app', config, migratedFrom: null };
}

describe('computeContextKeys', () => {
  it('is false for no folders, missing, invalid and unsafe configurations', () => {
    const none = { hasConfig: false, hasUploadTarget: false };
    expect(computeContextKeys([])).toEqual(none);
    expect(
      computeContextKeys([
        { status: 'missing', dir: '/srv/x' },
        { status: 'invalid', dir: '/srv/y', errors: ['broken'] },
        { status: 'unsafe', problem: 'is a symbolic link' },
        ok([]),
      ]),
    ).toEqual(none);
  });

  it('has a config but no upload target with only in-place servers or no mappings', () => {
    expect(computeContextKeys([ok([inplaceServer()])])).toEqual({
      hasConfig: true,
      hasUploadTarget: false,
    });
    expect(computeContextKeys([ok([sftpServer({ mappings: [] })])])).toEqual({
      hasConfig: true,
      hasUploadTarget: false,
    });
  });

  it('has an upload target when any folder has an SFTP server with a mapping', () => {
    expect(computeContextKeys([ok([inplaceServer()]), ok([sftpServer()])])).toEqual({
      hasConfig: true,
      hasUploadTarget: true,
    });
  });
});
