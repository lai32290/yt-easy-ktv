// Gera dist/ktv-extension.zip com o conteúdo de extension/ (sem arquivos de dev).
import { mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(raiz, 'extension');
const distDir = join(raiz, 'dist');
const saida = join(distDir, 'ktv-extension.zip');

// Arquivos que não devem ir no pacote.
const IGNORAR = /(^|\/)(\.DS_Store|Thumbs\.db|.*\.map|.*\.test\.js|.*~|\.git.*)$/;

function listar(dir) {
  const r = [];
  for (const nome of readdirSync(dir).sort()) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) r.push(...listar(p));
    else r.push(p);
  }
  return r;
}

// CRC-32 próprio (zlib.crc32 só existe em Node recente).
const TABELA = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function falhar(msg) {
  console.error('ERRO: ' + msg);
  process.exit(1);
}

if (!existsSync(join(extDir, 'manifest.json'))) falhar('extension/manifest.json não encontrado.');
const arquivos = listar(extDir)
  .map((p) => relative(extDir, p).split(sep).join('/'))
  .filter((rel) => !IGNORAR.test(rel));
if (!arquivos.length) falhar('nenhum arquivo para empacotar.');

mkdirSync(distDir, { recursive: true });
rmSync(saida, { force: true });

// 1) Tenta o binário `zip`.
const r = process.env.KTV_SEM_ZIP ? { status: 1 } : spawnSync('zip', ['-X', '-q', saida, ...arquivos], { cwd: extDir });
if (r.status === 0 && existsSync(saida)) {
  console.log(`Gerado ${relative(raiz, saida)} (${arquivos.length} arquivos, via zip).`);
  process.exit(0);
}

// 2) Fallback: escreve o zip com módulos nativos do Node (deflate).
try {
  const partes = [];
  const central = [];
  let offset = 0;
  for (const rel of arquivos) {
    const dados = readFileSync(join(extDir, rel));
    const nome = Buffer.from(rel, 'utf8');
    const comp = deflateRawSync(dados);
    const crc = crc32(dados);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    lh.writeUInt16LE(8, 8);      // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(dados.length, 22);
    lh.writeUInt16LE(nome.length, 26);
    partes.push(lh, nome, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(dados.length, 24);
    ch.writeUInt16LE(nome.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nome);
    offset += lh.length + nome.length + comp.length;
  }
  const tamCentral = central.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamCentral, 12);
  fim.writeUInt32LE(offset, 16);
  writeFileSync(saida, Buffer.concat([...partes, ...central, fim]));
  console.log(`Gerado ${relative(raiz, saida)} (${arquivos.length} arquivos, via Node).`);
} catch (e) {
  falhar('não foi possível gerar o zip (sem binário zip e o fallback falhou): ' + e.message);
}
