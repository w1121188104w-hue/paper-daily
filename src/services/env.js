import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const index = trimmed.indexOf('=');
  if (index < 0) return null;
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if (!key) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

try {
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
} catch {
  // `.env` is optional; production deployments can use real environment vars.
}
