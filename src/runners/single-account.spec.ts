import * as fs from 'fs';
import * as path from 'path';

/**
 * Single-account invariant guard (story 5.6 / EVO-1228, FR44).
 *
 * evo-flow is single-account by PRD §7 and Architecture §Architectural
 * Decisions. This spec greps every runner source file for account-routing
 * keywords so a stray `if (account.tier === 'premium')` in a hot path fails
 * CI instead of silently reintroducing multi-tenancy.
 *
 * To clear a failure: remove the account routing, or — when the match is
 * genuinely neutral (e.g. a log-only field) — add a documented entry to
 * ALLOWED_LINE_PATTERNS below. Exceptions live HERE, as literals, so every
 * addition is visible in code review.
 */

const RUNNERS_DIR = __dirname;

const RUNNER_MODES = [
  'campaign-packer',
  'campaign-sender',
  'event-receiver',
  'event-process',
];

const FORBIDDEN_PATTERNS: Array<{ keyword: string; pattern: RegExp }> = [
  { keyword: 'accountId', pattern: /\baccountId\b/i },
  { keyword: 'account_id', pattern: /\baccount_id\b/i },
  { keyword: 'Account.', pattern: /\baccount\./i },
  { keyword: 'tenant', pattern: /\btenant/i },
  { keyword: 'accountById', pattern: /\baccountById\b/i },
  { keyword: 'byAccount', pattern: /\bbyAccount\b/i },
];

/**
 * Lines matching any of these are exempt from the scan. Keep each entry
 * justified — this list is the audit trail of every sanctioned mention.
 */
const ALLOWED_LINE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // The DB seam (ADR14, story 10.1b): single-account in community, the RLS
    // extension point in enterprise. Injecting it is the sanctioned way to
    // reach Postgres — it is not account routing.
    pattern: /TenantDbContext|tenantDb/,
    reason: 'ADR14 tenant DB-context seam',
  },
];

interface Violation {
  file: string;
  line: number;
  keyword: string;
  text: string;
}

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
      return [];
    }
    return [fullPath];
  });
}

function scanContent(content: string, fileLabel: string): Violation[] {
  const violations: Violation[] = [];
  content.split('\n').forEach((text, index) => {
    if (ALLOWED_LINE_PATTERNS.some(({ pattern }) => pattern.test(text))) {
      return;
    }
    for (const { keyword, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) {
        violations.push({ file: fileLabel, line: index + 1, keyword, text });
        break;
      }
    }
  });
  return violations;
}

function scanDirectory(dir: string): Violation[] {
  return collectSourceFiles(dir).flatMap((file) =>
    scanContent(
      fs.readFileSync(file, 'utf8'),
      path.relative(RUNNERS_DIR, file),
    ),
  );
}

function assertNoViolations(violations: Violation[], scope: string): void {
  if (violations.length === 0) return;

  const report = violations
    .map(
      (v) =>
        `  ${v.file}:${v.line} — keyword "${v.keyword}" — ${v.text.trim()}`,
    )
    .join('\n');
  throw new Error(
    `Account routing detected in ${scope} (single-account invariant, FR44).\n` +
      'Remove the routing/scoping, or add a justified entry to ' +
      `ALLOWED_LINE_PATTERNS in single-account.spec.ts if the line is neutral.\n${report}`,
  );
}

describe('single-account invariant (FR44 / EVO-1228)', () => {
  RUNNER_MODES.forEach((mode) => {
    it(`keeps src/runners/${mode} free of account routing`, () => {
      const dir = path.join(RUNNERS_DIR, mode);
      expect(fs.existsSync(dir)).toBe(true);
      assertNoViolations(scanDirectory(dir), `src/runners/${mode}`);
    });
  });

  it('covers every runner directory, including future modes', () => {
    assertNoViolations(scanDirectory(RUNNERS_DIR), 'src/runners');
  });

  it('detects account routing when introduced (guard self-test)', () => {
    const snippet = [
      'export function dispatch(account: { tier: string }) {',
      "  if (account.tier === 'premium') {",
      '    return fastLane();',
      '  }',
      '}',
    ].join('\n');

    const violations = scanContent(snippet, 'campaign-sender/example.ts');

    expect(violations).toEqual([
      expect.objectContaining({
        file: 'campaign-sender/example.ts',
        line: 2,
        keyword: 'Account.',
      }),
    ]);
  });

  it('keeps allowed lines exempt (documented exceptions)', () => {
    const violations = scanContent(
      'constructor(private readonly db: TenantDbContext) {}',
      'campaign-packer/example.ts',
    );

    expect(violations).toEqual([]);
  });
});
