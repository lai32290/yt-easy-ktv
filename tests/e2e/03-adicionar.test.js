// Critério: "posso buscar uma música e colar um link; ambos adicionam à fila; duplicata aceita".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente } from './helpers/ambiente.js';
import { ERR_TEXT } from '../../extension/src/shared/protocol.js';

const ID = (n) => `bbbbbbbbbb${n}`;

test('c) buscar (com /results simulado) e adicionar à fila', { timeout: 120000 }, () => comAmbiente('busca', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Edu');

  const n = await cel.buscar('evidencias');
  assert.equal(n, 5);
  assert.deepEqual(amb.yt.consultas, ['evidencias karaokê'], 'sufixo karaokê aplicado por padrão');
  assert.ok(amb.yt.pedidos.filter((p) => p.tipo === 'busca').every((p) => p.doSw), 'a busca deveria sair do service worker');

  await cel.adicionarResultado(1);
  const s = await cel.esperarEstado((x) => x.fila.length === 1, { descricao: 'item da busca na fila' });
  assert.equal(s.fila[0].videoId, 'TGXkdU9S0OU');
  assert.match(s.fila[0].titulo, /Karaokê/);
  assert.equal(s.fila[0].duracao, '5:03');
  // Resultado vindo da busca não precisa de oEmbed.
  assert.equal(amb.yt.pedidos.filter((p) => p.tipo === 'oembed').length, 0);

  // O mesmo resultado aparece como "Adicionar de novo" (habilitado: duplicata é permitida).
  const btn = cel.page.getByTestId('result-item').nth(1).getByTestId('add-btn');
  await btn.waitFor();
  assert.equal(await btn.textContent(), 'Adicionar de novo');
  assert.ok(await btn.isEnabled());

  // Sufixo desligado: a consulta vai sem "karaokê".
  await cel.page.locator('#karaoke-check').uncheck();
  await cel.buscar('trem bala');
  assert.equal(amb.yt.consultas.at(-1), 'trem bala');
}));

test('c) busca no formato lockupViewModel também lista resultados', { timeout: 120000 }, () => comAmbiente('busca-lockup', async (amb) => {
  amb.yt.busca = 'lockup';
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Edu');
  assert.equal(await cel.buscar('evidencias'), 4);
  await cel.adicionarResultado(2);
  const s = await cel.esperarEstado((x) => x.fila.length === 1);
  assert.equal(s.fila[0].videoId, 'VJ34zhontgg');
}));

test('c) busca que falha avisa em pt-BR e sugere colar o link', { timeout: 120000 }, () => comAmbiente('busca-falha', async (amb) => {
  amb.yt.busca = 'falha';
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Edu');
  await cel.aba('buscar');
  await cel.page.getByTestId('search-input').fill('qualquer coisa');
  await cel.page.getByTestId('search-btn').click();
  await cel.toastErro(ERR_TEXT.busca_falhou);
  assert.match(await cel.page.locator('#search-status').textContent(), /colar o link/);

  amb.yt.busca = 'vazia'; // página sem ytInitialData (formato mudou / consentimento)
  await cel.page.getByTestId('search-btn').click();
  await cel.toastErro(ERR_TEXT.busca_falhou);
}));

test('c) colar link: youtu.be, watch?v= (com &list= ignorado) e shorts', { timeout: 120000 }, () => comAmbiente('links', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Fabi');

  await cel.colarLink(`https://youtu.be/${ID(1)}?si=abc`);
  await cel.esperarEstado((x) => x.fila.length === 1);
  await cel.colarLink(`https://www.youtube.com/watch?v=${ID(2)}&list=PLabcdefghijk&index=3`);
  await cel.esperarEstado((x) => x.fila.length === 2);
  await cel.colarLink(`https://www.youtube.com/shorts/${ID(3)}`);
  const s = await cel.esperarEstado((x) => x.fila.length === 3);
  assert.deepEqual(s.fila.map((i) => i.videoId), [ID(1), ID(2), ID(3)]);
  assert.deepEqual(s.fila.map((i) => i.titulo), [`Música ${ID(1)}`, `Música ${ID(2)}`, `Música ${ID(3)}`]);
  assert.ok(amb.yt.pedidos.filter((p) => p.tipo === 'oembed').every((p) => p.doSw), 'oEmbed deveria sair do SW');
  assert.equal(await cel.itensFila().count(), 3);

  // oEmbed recusa com 401 (incorporação desligada): entra com título provisório.
  amb.yt.oembedFalha.set(ID(4), 401);
  await cel.colarLink(`https://youtu.be/${ID(4)}`);
  const s4 = await cel.esperarEstado((x) => x.fila.length === 4);
  assert.equal(s4.fila[3].titulo, `Vídeo ${ID(4)}`);

  // oEmbed 404 (vídeo removido): recusado com aviso.
  amb.yt.oembedFalha.set(ID(5), 404);
  await cel.colarLink(`https://youtu.be/${ID(5)}`);
  await cel.toastErro(ERR_TEXT.video_indisponivel);
  assert.equal((await cel.estado()).fila.length, 4);
}));

test('c) duplicata é aceita; link inválido é recusado com mensagem em pt-BR', { timeout: 120000 }, () => comAmbiente('duplicata', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Gabi');
  await cel.colarLink(`https://youtu.be/${ID(1)}`);
  await cel.esperarEstado((x) => x.fila.length === 1);

  // mesmo vídeo por outro formato de link: entra de novo
  await cel.colarLink(`https://www.youtube.com/watch?v=${ID(1)}&list=PLxyz`);
  await cel.esperarEstado((x) => x.fila.length === 2);

  await cel.colarLink('https://exemplo.com/nao-e-youtube');
  await cel.toastErro(ERR_TEXT.link_invalido);
  await cel.colarLink('texto qualquer');
  await cel.toastErro(ERR_TEXT.link_invalido);
  assert.equal((await cel.estado()).fila.length, 2, 'os links inválidos não mexem na fila (as duas cópias ficam)');
}));
