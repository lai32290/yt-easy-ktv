// Critério: "recarregar a extensão / suspender o SW não perde a fila" (mesma sala, mesma música).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate, espera } from './helpers/ambiente.js';

const ID = (n) => `ffffffffff${n}`;

test('g) parar o service worker (como o Chrome faz) não perde fila, música atual nem sala', { timeout: 180000 }, () => comAmbiente('sw-restart', async (amb) => {
  amb.yt.duracao = 25;
  await amb.prepararKtv();
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1));
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.colarLink(`https://youtu.be/${ID(3)}`);
  const antes = await ana.esperarEstado((s) => s.fila.length === 2);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(1)), { descricao: 'ID1 tocando' });
  const roomAntes = amb.roomId;

  await amb.pararSw();

  // Qualquer evento acorda o SW (aqui: o celular pede algo). Estado idêntico, mesma sala.
  await ana.colarLink(`https://youtu.be/${ID(4)}`);
  const depois = await ana.esperarEstado((s) => s.fila.length === 3, { descricao: 'pedido processado pelo SW novo' });
  assert.ok(await amb.swReiniciou(), 'o SW deveria ter sido reiniciado (estado global zerado)');
  assert.equal(depois.atual.itemId, antes.atual.itemId, 'a música atual mudou');
  assert.deepEqual(depois.fila.slice(0, 2).map((i) => i.itemId), antes.fila.map((i) => i.itemId));

  const st = await amb.storage();
  assert.equal(st.ktv_state.roomId, roomAntes, 'a sala mudou');
  assert.equal(st.ktv_state.atual.videoId, ID(1));
  assert.equal(st.ktv_rt.started, true);

  // A música atual continua tocando (a aba não foi reiniciada) e o celular segue conectado.
  assert.equal(await ana.status(), 'conectado');
  const pg = await amb.paginaKtv();
  assert.equal(pg.videoId, ID(1));
  assert.equal(pg.pausado, false);
  assert.equal(pg.fake.carregados.filter((x) => x === ID(1)).length, 1, 'a música atual foi recarregada');

  // Pular depois do reinício continua funcionando: o SW novo ainda reconhece a aba KTV e comanda o player.
  await ana.pular();
  await ana.esperarEstado((s) => s.atual?.videoId === ID(2));
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(2)), { descricao: 'ID2 tocando' });
}));

test('g) SW parado ENQUANTO a música termina: a próxima ainda toca (ended acorda o SW)', { timeout: 180000 }, () => comAmbiente('sw-restart-ended', async (amb) => {
  amb.yt.duracoes.set(ID(1), 5);
  amb.yt.duracao = 20;
  await amb.prepararKtv();
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1));
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.esperarEstado((s) => s.fila.length === 1);
  await amb.pararSw();
  // sem nenhuma interação: ID1 termina sozinho (5s), o content script manda `ended` e acorda o SW
  const s = await ana.esperarEstado((x) => x.atual?.videoId === ID(2), { timeout: 40000, descricao: 'ID2 assumiu após ended com SW parado' });
  assert.equal(s.fila.length, 0);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(2)), { timeout: 30000, descricao: 'ID2 tocando' });
}));

test('g) perda do offscreen + SW (como ao recarregar a extensão): mesma sala, fila intacta, celular volta sozinho', { timeout: 180000 }, () => comAmbiente('offscreen-perdido', async (amb) => {
  amb.yt.duracao = 40;
  await amb.prepararKtv();
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1));
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  const antes = await ana.esperarEstado((s) => s.fila.length === 1);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(1)), { descricao: 'ID1 tocando' });
  const roomAntes = amb.roomId;

  // Recarregar a extensão destrói o offscreen document (com o Peer) e o SW. Fazemos o mesmo à mão.
  // (chrome.runtime.reload() não religa extensões carregadas por linha de comando neste Chromium headless.)
  const sw = await amb.sw();
  await sw.evaluate(() => chrome.offscreen.closeDocument());
  await amb.pararSw();
  await ana.esperarStatus('conectando', 30000).catch(() => {}); // o celular nota a queda (ou já está tentando)

  // O usuário recarrega a aba KTV (F5): o content script pergunta ao SW (whoami), que acorda e recria o offscreen.
  await amb.ktv.reload();
  const st = await ate(async () => {
    const s = await amb.storage();
    return s.ktv_state?.roomId === roomAntes && s.ktv_rt?.conns?.signaling === true ? s : null;
  }, { timeout: 40000, descricao: 'sala recuperada com o mesmo roomId e sinalização ok' });
  assert.ok(await amb.swReiniciou());
  assert.equal(st.ktv_state.atual.itemId, antes.atual.itemId);
  assert.deepEqual(st.ktv_state.fila.map((i) => i.itemId), antes.fila.map((i) => i.itemId));
  assert.equal(st.ktv_rt.ktvTabId != null, true);

  // O mesmo celular reconecta sem novo QR/link e vê o mesmo estado.
  await ana.esperarStatus('conectado', 60000);
  const depois = await ana.esperarEstado((s) => s.atual?.itemId === antes.atual.itemId && s.fila.length === 1, { descricao: 'estado igual após reconexão' });
  assert.equal(depois.fila[0].itemId, antes.fila[0].itemId);
  // A aba KTV recarregada retoma a música atual. O documento novo não tem gesto do usuário: se o Chrome
  // barrar o autoplay, o botão "Tocar" aparece (comportamento previsto) e um clique retoma.
  await ate(async () => {
    const p = await amb.paginaKtv();
    if (!p || p.videoId !== ID(1)) return false;
    if (!p.pausado) return true;
    const btn = amb.ktv.locator('#ktv-root .btn-tocar');
    if (await btn.isVisible().catch(() => false)) { await btn.click(); }
    return false;
  }, { timeout: 30000, descricao: 'música atual retomada após F5' });
}));

test('g) offscreen perdido com o SW vivo: recarregar a aba KTV recria a sala com o mesmo roomId', { timeout: 150000 }, () => comAmbiente('offscreen-sem-sw', async (amb) => {
  amb.yt.duracao = 40;
  await amb.prepararKtv();
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1));
  const roomAntes = amb.roomId;

  const sw = await amb.sw();
  await sw.evaluate(() => chrome.offscreen.closeDocument()); // o renderer do offscreen "caiu"; o SW segue vivo
  await amb.ktv.reload(); // whoami -> SW percebe que não há offscreen e o recria
  await ate(async () => {
    const s = await amb.storage();
    return s.ktv_state.roomId === roomAntes && s.ktv_rt.conns.signaling === true;
  }, { timeout: 40000, descricao: 'sala recriada com o mesmo roomId' });
  await ana.esperarStatus('conectado', 60000);
  const s = await ana.esperarEstado((x) => x.atual?.videoId === ID(1));
  assert.equal(s.fila.length, 0);
}));
