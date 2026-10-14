import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ConfigFileSchema, type ConfigFile } from '@agentui/shared';

// Charge .env s'il existe (Node ≥ 20.12) ; les variables déjà définies restent prioritaires.
for (const f of ['.env', '../../.env']) if (existsSync(f)) process.loadEnvFile(f);

/** Remplace ${VAR} par process.env.VAR (erreur si absente). */
function interpolate(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      line.trimStart().startsWith('#')
        ? line // pas d'interpolation dans les commentaires
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
  if (!existsSync(path)) throw new Error(`Fichier de configuration introuvable : ${path}`);
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
