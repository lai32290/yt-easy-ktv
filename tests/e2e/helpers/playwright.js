// Carrega o Playwright instalado globalmente (o projeto não o tem como dependência).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);

function carregar() {
  try { return require('playwright'); } catch { /* tenta o prefixo global */ }
  const raiz = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return require(path.join(raiz, 'playwright'));
}

export const { chromium } = carregar();
