import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// EVO-1829 regression guard: Temporal activities must NOT bootstrap a second
// Nest app via createApplicationContext(AppModule.forRoot()). That boots a
// redundant worker + Kafka consumers in-process and silently freezes
// single-mode. Activities resolve DI from the primary context via
// app-context.holder (getAppContext) instead.
describe('EVO-1829: activities never bootstrap a second AppModule', () => {
  const ACTIVITIES_DIR = __dirname;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });
  }

  it('no activity file calls createApplicationContext(AppModule.forRoot())', () => {
    const pattern = /createApplicationContext\s*\(\s*AppModule\.forRoot\(/;
    const offenders = walk(ACTIVITIES_DIR).filter((file) =>
      pattern.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
