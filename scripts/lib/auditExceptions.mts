/**
 * Decides whether an `npm audit --json` report is acceptable: every advisory of severity high
 * or critical fails, unless it is listed in `AUDIT_EXCEPTIONS` for that package and the
 * exception has not expired yet. An expired exception fails again, so it cannot be forgotten.
 */

export interface AuditException {
  /** GitHub advisory id, e.g. `GHSA-xxxx-xxxx-xxxx`. */
  readonly id: string;
  /** The package the advisory is reported for; the exception does not apply elsewhere. */
  readonly package: string;
  /** Last day (UTC, inclusive) on which the advisory is tolerated, as `YYYY-MM-DD`. */
  readonly expires: string;
  readonly reason: string;
}

export const AUDIT_EXCEPTIONS: readonly AuditException[] = [
  {
    id: 'GHSA-fc5q-39xc-vjpf',
    package: 'picomatch',
    expires: '2026-12-15',
    reason:
      'No patched release exists yet. Only development tools (Vitest, Vite, vsce, ' +
      'typescript-eslint) depend on it, with glob patterns from this repository; the ' +
      'extension does not ship it.',
  },
];

export interface AuditResult {
  readonly failures: string[];
  readonly tolerated: string[];
  readonly unused: string[];
}

const BLOCKING = new Set(['high', 'critical']);
const ADVISORY_ID = /\/(GHSA(?:-[0-9a-z]{4}){3})$/i;

interface Advisory {
  readonly name: string;
  readonly url: string;
  readonly title: string;
  readonly severity: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asAdvisory(value: unknown): Advisory | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { name, url, title, severity } = value;
  if (
    typeof name !== 'string' ||
    typeof url !== 'string' ||
    typeof title !== 'string' ||
    typeof severity !== 'string'
  ) {
    return undefined;
  }
  return { name, url, title, severity };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function evaluateAudit(
  report: unknown,
  exceptions: readonly AuditException[],
  today: string,
): AuditResult {
  const failures: string[] = [];
  const tolerated: string[] = [];
  const used = new Set<AuditException>();

  if (
    !isRecord(report) ||
    report['auditReportVersion'] !== 2 ||
    !isRecord(report['vulnerabilities'])
  ) {
    const detail =
      isRecord(report) && 'error' in report ? JSON.stringify(report['error']) : 'unexpected shape';
    return {
      failures: [`The npm audit report could not be evaluated (${detail}).`],
      tolerated,
      unused: [],
    };
  }

  const seen = new Set<string>();
  let blocking = 0;
  for (const entry of Object.values(report['vulnerabilities'])) {
    const via: unknown = isRecord(entry) ? entry['via'] : undefined;
    for (const item of Array.isArray(via) ? via : []) {
      const advisory = asAdvisory(item);
      if (advisory === undefined || !BLOCKING.has(advisory.severity)) {
        continue;
      }
      blocking += 1;
      const id = ADVISORY_ID.exec(advisory.url)?.[1];
      const label = `${advisory.name}: ${id ?? advisory.url}`;
      if (seen.has(label)) {
        continue;
      }
      seen.add(label);
      const description = `${label} (${advisory.severity}) ${advisory.title}`;
      const exception = exceptions.find(
        (candidate) =>
          id !== undefined &&
          candidate.id.toLowerCase() === id.toLowerCase() &&
          candidate.package === advisory.name,
      );
      if (exception === undefined) {
        failures.push(description);
      } else if (today > exception.expires) {
        used.add(exception);
        failures.push(`${description} — exception expired on ${exception.expires}`);
      } else {
        used.add(exception);
        tolerated.push(`${label} until ${exception.expires}`);
      }
    }
  }

  const summary = isRecord(report['metadata']) ? report['metadata']['vulnerabilities'] : undefined;
  const counted = isRecord(summary) ? count(summary['high']) + count(summary['critical']) : 0;
  if (counted > 0 && blocking === 0) {
    failures.push(
      `The audit summary reports ${counted} high or critical finding(s), but no advisory explains them.`,
    );
  }

  const unused = exceptions
    .filter((exception) => !used.has(exception))
    .map((exception) => `${exception.package}: ${exception.id}`);
  return { failures, tolerated, unused };
}
