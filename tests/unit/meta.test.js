import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oembed } from '../../extension/src/background/meta.js';

const resp = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

test('oembed: devolve titulo e canal e monta a URL certa', async () => {
  let pedida;
  const r = await oembed('dQw4w9WgXcQ', async (u) => {
    pedida = u;
    return resp(200, { title: 'Música', author_name: 'Canal X' });
  });
  assert.deepEqual(r, { titulo: 'Música', canal: 'Canal X', duracao: '' });
  const u = new URL(pedida);
  assert.equal(u.origin + u.pathname, 'https://www.youtube.com/oembed');
  assert.equal(u.searchParams.get('url'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(u.searchParams.get('format'), 'json');
});

test('oembed: HTTP de erro lança video_indisponivel com status', async () => {
  await assert.rejects(oembed('x', async () => resp(404, {})), (e) => e.codigo === 'video_indisponivel' && e.status === 404);
});

test('oembed: falha de rede e JSON inválido lançam video_indisponivel', async () => {
  await assert.rejects(oembed('x', async () => { throw new Error('offline'); }), { codigo: 'video_indisponivel' });
  await assert.rejects(oembed('x', async () => resp(200, { sem: 'titulo' })), { codigo: 'video_indisponivel' });
  await assert.rejects(
    oembed('x', async () => ({ ok: true, status: 200, json: async () => { throw new Error('json'); } })),
    { codigo: 'video_indisponivel' },
  );
});
