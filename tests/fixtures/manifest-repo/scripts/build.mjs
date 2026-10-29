// Fixture build script: proves the import engine ran the manifest build command.
// Writes `built.txt` at the repository root with the injected environment state.
import { writeFileSync } from 'node:fs';

const payload = {
  built: true,
  mode: process.env.FIXTURE_MODE ?? null,
  hasToken: typeof process.env.FIXTURE_API_TOKEN === 'string' && process.env.FIXTURE_API_TOKEN.length > 0,
};

writeFileSync(new URL('../built.txt', import.meta.url), `${JSON.stringify(payload, null, 2)}\n`);
console.log('manifest-repo fixture build complete');
