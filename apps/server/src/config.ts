import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ConfigFileSchema, type ConfigFile } from '@agentui/shared';

// Loads .env if it exists (Node ≥ 20.12); variables already defined keep priority.
for (const f of ['.env', '../../.env']) if (existsSync(f)) process.loadEnvFile(f);

/** Replaces ${VAR} with process.env.VAR (error if missing). */
function interpolate(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      line.trimStart().startsWith('#')
        ? line // no interpolation in comments
        : line.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
            const v = process.env[name];
            if (v === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
            return JSON.stringify(v).slice(1, -1);
          }),
    )
    .join('\n');
}

export function loadConfig(
  path = process.env.AGENTS_CONFIG ?? ['agents.config.yaml', '../../agents.config.yaml'].find(existsSync) ?? 'agents.config.yaml',
): ConfigFile {
  if (!existsSync(path)) throw new Error(`Configuration file not found: ${path}`);
  return ConfigFileSchema.parse(parse(interpolate(readFileSync(path, 'utf8'))));
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: resolve(process.env.DATA_DIR ?? resolve(import.meta.dirname, '../../../data')),
  cookieSecret: process.env.COOKIE_SECRET ?? '',
  adminUser: process.env.ADMIN_USER,
  adminPassword: process.env.ADMIN_PASSWORD,
  secureCookies: process.env.INSECURE_COOKIES !== '1',
};
