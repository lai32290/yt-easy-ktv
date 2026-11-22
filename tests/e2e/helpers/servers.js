// Servidores locais dos testes: sinalização PeerJS (reiniciável) e site estático do celular.
import http from 'node:http';
import { fork } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const WEB_DIR = path.join(RAIZ, 'web');
export const EXT_DIR = path.join(RAIZ, 'extension');
export const FIXTURES_DIR = path.join(RAIZ, 'tests', 'fixtures');

export function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function escutar(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

/** Servidor de sinalização PeerJS em 127.0.0.1 (path '/', sem TLS), num processo filho. `parar()`/`iniciar()` simulam queda. */
export async function criarSinalizacao(port) {
  port ??= await portaLivre();
  let filho = null;
  const iniciar = async () => {
    if (filho) return;
    const f = fork(path.join(path.dirname(fileURLToPath(import.meta.url)), 'peer-server-child.js'), [String(port)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    filho = f;
    await new Promise((resolve, reject) => {
      f.once('message', (m) => (m === 'pronto' ? resolve() : reject(new Error('peer server: ' + m))));
      f.once('exit', (c) => reject(new Error('peer server saiu: ' + c)));
    });
    f.removeAllListeners('exit');
    f.on('exit', () => { if (filho === f) filho = null; });
  };
  const parar = async () => {
    const f = filho;
    if (!f) return;
    filho = null;
    await new Promise((r) => { f.once('exit', r); f.kill('SIGKILL'); });
  };
  await iniciar();
  return {
    port, host: '127.0.0.1', iniciar, parar,
    get ativo() { return !!filho; },
    config: { host: '127.0.0.1', port, path: '/', secure: false },
  };
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** Site estático (a pasta web/) em 127.0.0.1. */
export async function criarSiteEstatico(dir = WEB_DIR) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const arq = path.join(dir, path.normalize(rel));
    if (!arq.startsWith(dir)) { res.writeHead(403).end(); return; }
    fs.readFile(arq, (err, buf) => {
      if (err) { res.writeHead(404).end('nao encontrado'); return; }
      res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await escutar(server, 0);
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/index.html`,
    fechar: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(() => r())); },
  };
}
