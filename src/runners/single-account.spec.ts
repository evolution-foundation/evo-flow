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
 * Sanctioned tokens, STRIPPED from each line before the scan (never a
 * whole-line exemption — that would let `routeByTenant(); // tenantDb` slip
 * through). Keep each entry justified — this list is the audit trail of every
 * sanctioned mention.
 */
const ALLOWED_TOKENS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // The DB seam (ADR14, story 10.1b): single-account in community, the RLS
    // extension point in enterprise. Injecting it is the sanctioned way to
    // reach Postgres — it is not account routing.
    pattern: /TenantDbContext|tenantDbContext/g,
    reason: 'ADR14 tenant DB-context seam',
  },
];

/**
 * Neutral-line exemptions (AC3): each pattern MUST match the ENTIRE trimmed
 * line (`^...$`, no `g` flag — enforced by a self-test below). A line that
 * fully matches is skipped; one extra character (e.g. routing glued onto the
 * same line) breaks the anchor and the guard fires. Empty today — no runner
 * has a neutral mention. Example entry for a log-only field:
 *   { pattern: /^logger\.log\(\{ accountId: ingestion\.accountId \}\);$/,
 *     reason: 'EVO-XXXX log-only field, no flow impact' },
 */
const ALLOWED_LINE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [];

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

function scanContent(
  content: string,
  fileLabel: string,
  allowedLines: Array<{ pattern: RegExp; reason: string }> = ALLOWED_LINE_PATTERNS,
): Violation[] {
  const violations: Violation[] = [];
  content.split('\n').forEach((text, index) => {
    if (allowedLines.some(({ pattern }) => pattern.test(text.trim()))) {
      return;
    }
    const scannable = ALLOWED_TOKENS.reduce(
      (line, { pattern }) => line.replace(pattern, ''),
      text,
    );
    for (const { keyword, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(scannable)) {
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
      if (!fs.existsSync(dir)) {
        throw new Error(
          `Runner directory missing: src/runners/${mode} — update RUNNER_MODES if it was renamed.`,
        );
      }
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

  it('keeps allowed tokens exempt (documented exceptions)', () => {
    const violations = scanContent(
      'constructor(private readonly db: TenantDbContext) {}',
      'campaign-packer/example.ts',
    );

    expect(violations).toEqual([]);
  });

  it('does not let an allowed token launder real routing on the same line', () => {
    const violations = scanContent(
      'routeByTenant(tenantId); // wrapped by TenantDbContext',
      'campaign-sender/example.ts',
    );

    expect(violations).toEqual([
      expect.objectContaining({ line: 1, keyword: 'tenant' }),
    ]);
  });

  describe('neutral-line exemptions (AC3)', () => {
    const NEUTRAL_LOG_ALLOWLIST = [
      {
        pattern: /^logger\.log\(\{ accountId: ingestion\.accountId \}\);$/,
        reason: 'test fixture: log-only field, no flow impact',
      },
    ];

    it('exempts a documented neutral log mention', () => {
      const violations = scanContent(
        '  logger.log({ accountId: ingestion.accountId });',
        'event-process/example.ts',
        NEUTRAL_LOG_ALLOWLIST,
      );

      expect(violations).toEqual([]);
    });

    it('still fails the same mention when it is not allowlisted', () => {
      const violations = scanContent(
        '  logger.log({ accountId: ingestion.accountId });',
        'event-process/example.ts',
      );

      expect(violations).toEqual([
        expect.objectContaining({ line: 1, keyword: 'accountId' }),
      ]);
    });

    it('does not let an allowlisted line launder routing appended to it', () => {
      const violations = scanContent(
        'logger.log({ accountId: ingestion.accountId }); routeByAccount(accountId);',
        'event-process/example.ts',
        NEUTRAL_LOG_ALLOWLIST,
      );

      expect(violations).toEqual([
        expect.objectContaining({ line: 1, keyword: 'accountId' }),
      ]);
    });

    it('requires every entry to anchor the whole line and stay stateless', () => {
      for (const { pattern } of [
        ...ALLOWED_LINE_PATTERNS,
        ...NEUTRAL_LOG_ALLOWLIST,
      ]) {
        expect(pattern.source.startsWith('^')).toBe(true);
        expect(pattern.source.endsWith('$')).toBe(true);
        expect(pattern.flags).not.toContain('g');
      }
    });
  });
});
