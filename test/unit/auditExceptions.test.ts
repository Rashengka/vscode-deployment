import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXCEPTIONS,
  type AuditException,
  evaluateAudit,
} from '../../scripts/lib/auditExceptions.mts';

const PICOMATCH = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';

function advisory(name: string, url: string, severity: string) {
  return { source: 1, name, dependency: name, title: `${name} issue`, url, severity, range: '*' };
}

function report(
  vulnerabilities: Record<string, { severity: string; via: unknown[] }>,
  counts: Partial<Record<'low' | 'moderate' | 'high' | 'critical', number>> = {},
): unknown {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts },
    },
  };
}

const EXCEPTION: AuditException = {
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  expires: '2026-12-15',
  reason: 'No patched release exists; only development tools depend on it.',
};

const PICOMATCH_REPORT = report(
  {
    picomatch: { severity: 'high', via: [advisory('picomatch', PICOMATCH, 'high')] },
    vitest: { severity: 'high', via: ['picomatch'] },
  },
  { high: 2 },
);

describe('evaluateAudit', () => {
  it('passes a clean report', () => {
    const result = evaluateAudit(report({}), [EXCEPTION], '2026-11-18');
    expect(result.failures).toEqual([]);
    expect(result.tolerated).toEqual([]);
  });

  it('fails a high advisory without an exception', () => {
    const result = evaluateAudit(PICOMATCH_REPORT, [], '2026-11-18');
    expect(result.failures).toEqual(['picomatch: GHSA-fc5q-39xc-vjpf (high) picomatch issue']);
  });

  it('tolerates an excepted advisory until and including its expiry date', () => {
    for (const today of ['2026-11-18', '2026-12-15']) {
      const result = evaluateAudit(PICOMATCH_REPORT, [EXCEPTION], today);
      expect(result.failures).toEqual([]);
      expect(result.tolerated).toEqual(['picomatch: GHSA-fc5q-39xc-vjpf until 2026-12-15']);
    }
  });

  it('fails an excepted advisory after its expiry date', () => {
    const result = evaluateAudit(PICOMATCH_REPORT, [EXCEPTION], '2026-12-16');
    expect(result.failures).toEqual([
      'picomatch: GHSA-fc5q-39xc-vjpf (high) picomatch issue — exception expired on 2026-12-15',
    ]);
  });

  it('does not apply an exception to the same advisory id in another package', () => {
    const other = report(
      { otherglob: { severity: 'high', via: [advisory('otherglob', PICOMATCH, 'high')] } },
      { high: 1 },
    );
    expect(evaluateAudit(other, [EXCEPTION], '2026-11-18').failures).toHaveLength(1);
  });

  it('fails a new high advisory next to the excepted one', () => {
    const mixed = report(
      {
        picomatch: { severity: 'high', via: [advisory('picomatch', PICOMATCH, 'high')] },
        vite: {
          severity: 'critical',
          via: [advisory('vite', 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', 'critical')],
        },
      },
      { high: 1, critical: 1 },
    );
    expect(evaluateAudit(mixed, [EXCEPTION], '2026-11-18').failures).toEqual([
      'vite: GHSA-aaaa-bbbb-cccc (critical) vite issue',
    ]);
  });

  it('ignores advisories below high', () => {
    const moderate = report(
      {
        minimatch: {
          severity: 'moderate',
          via: [
            advisory('minimatch', 'https://github.com/advisories/GHSA-1111-2222-3333', 'moderate'),
          ],
        },
      },
      { moderate: 1 },
    );
    expect(evaluateAudit(moderate, [], '2026-11-18').failures).toEqual([]);
  });

  it('reports an exception that is no longer needed without failing', () => {
    const result = evaluateAudit(report({}), [EXCEPTION], '2026-11-18');
    expect(result.unused).toEqual(['picomatch: GHSA-fc5q-39xc-vjpf']);
    expect(result.failures).toEqual([]);
  });

  it.each([
    ['not an object', 'npm ERR! audit endpoint returned an error'],
    ['an npm error', { error: { code: 'ENOAUDIT', summary: 'no audit' } }],
    ['another report version', { auditReportVersion: 1, advisories: {} }],
    ['no vulnerabilities map', { auditReportVersion: 2, metadata: {} }],
  ])('fails when the report is %s', (_label, input) => {
    expect(evaluateAudit(input, [EXCEPTION], '2026-11-18').failures).toHaveLength(1);
  });

  it('fails when the summary counts high findings that no advisory explains', () => {
    const inconsistent = report({ vitest: { severity: 'high', via: ['picomatch'] } }, { high: 1 });
    expect(evaluateAudit(inconsistent, [], '2026-11-18').failures).toEqual([
      'The audit summary reports 1 high or critical finding(s), but no advisory explains them.',
    ]);
  });

  it('fails when an advisory has no GitHub advisory id', () => {
    const noId = report(
      { x: { severity: 'high', via: [advisory('x', 'https://example.com/x', 'high')] } },
      { high: 1 },
    );
    expect(evaluateAudit(noId, [], '2026-11-18').failures).toEqual([
      'x: https://example.com/x (high) x issue',
    ]);
  });
});

describe('AUDIT_EXCEPTIONS', () => {
  it('every exception names an advisory, a package, a reason and a valid date', () => {
    for (const exception of AUDIT_EXCEPTIONS) {
      expect(exception.id).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      expect(exception.package).not.toBe('');
      expect(exception.reason).not.toBe('');
      expect(exception.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${exception.expires}T00:00:00Z`))).toBe(false);
    }
  });
});
