// Critério: "a música termina e a próxima toca sozinha, sem interferência do autoplay do YouTube";
// fila vazia -> modo ocioso com QR grande.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate, espera } from './helpers/ambiente.js';
import { ID_RECOMENDADO } from './helpers/fake-youtube.js';

const ID = (n) => `dddddddddd${n}`;

async function tocarTresMusicas(amb, cel) {
  for (const n of [1, 2, 3]) {
    await cel.colarLink(`https://youtu.be/${ID(n)}`);
    await cel.esperarEstado((s) => [s.atual, ...s.fila].filter(Boolean).some((i) => i.videoId === ID(n)));
  }
}

// Confere que tocou 1 -> 2 -> 3 em ordem, sem o "recomendado" tocar de verdade e sem pular ninguém.
async function conferirSequencia(amb, cel) {
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(3)), { timeout: 40000, descricao: 'música 3 tocando' });
  const s = await cel.esperarEstado((x) => x.atual?.videoId === ID(3) && x.fila.length === 0);
  assert.equal(s.atual.videoId, ID(3));
  // termina a 3 -> ocioso, sem autoplay do YouTube levar a lugar nenhum
  await cel.esperarEstado((x) => !x.atual, { timeout: 30000, descricao: 'fila esgotada' });
  await ate(async () => (await amb.painel())?.ocioso, { descricao: 'modo ocioso' });
  await espera(2000); // o autoplay (se escapasse) já teria tocado o "recomendado"
  const pg = await amb.paginaKtv();
  assert.ok(pg.pausado, `a aba KTV continua tocando (${pg.url})`);
  return pg;
}

test('e) ao terminar, a próxima toca sozinha (autoplay do YouTube desligado pelo botão)', { timeout: 180000 }, () => comAmbiente('proxima', async (amb) => {
  amb.yt.duracao = 2;
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Hugo');
  await tocarTresMusicas(amb, cel);
  const pg = await conferirSequencia(amb, cel);
  // ordem de reprodução observada na página
  const ordem = [...new Set(pg.fake.playing)];
  assert.deepEqual(ordem, [ID(1), ID(2), ID(3)]);
  assert.equal(pg.fake.recTocou, 0, 'o vídeo recomendado do YouTube chegou a tocar');
  assert.ok(pg.fake.cliquesToggle >= 1, 'o KTV deveria ter desligado o botão de autoplay');
}));

test('e) autoplay do YouTube que ignora o botão é contido (pausa o recomendado e segue a fila)', { timeout: 180000 }, () => comAmbiente('autoplay-teimoso', async (amb) => {
  amb.yt.duracao = 2;
  amb.yt.autoplay = 'sempre';   // o YouTube falso navega para o "recomendado" ao terminar, mesmo com o botão desligado
  amb.yt.atrasoAutoplay = 0;
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Hugo');
  await tocarTresMusicas(amb, cel);
  const pg = await conferirSequencia(amb, cel);
  // O recomendado pode ter começado por milissegundos antes da guarda pausar, mas nunca ficou tocando
  // e a fila andou exatamente 1 -> 2 -> 3.
  assert.deepEqual([...new Set(pg.fake.playing.filter((x) => x !== ID_RECOMENDADO))], [ID(1), ID(2), ID(3)]);
  assert.ok(pg.pausado);
  assert.ok(pg.fake.carregados.includes(ID_RECOMENDADO), 'o autoplay falso nem chegou a tentar o recomendado (teste sem efeito)');
}));

test('e) mesmo com recarga completa da página (sem SPA) a fila toca em sequência', { timeout: 180000 }, () => comAmbiente('carga-completa', async (amb) => {
  amb.yt.duracao = 2;
  amb.yt.modo = 'full';         // clique no <a> recarrega a página inteira
  amb.yt.autoplay = 'nunca';
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Hugo');
  await tocarTresMusicas(amb, cel);
  await ate(async () => (await amb.paginaKtv())?.videoId === ID(3), { timeout: 45000, descricao: 'aba KTV em ID3' });
  await ate(async () => { const p = await amb.paginaKtv(); return p && !p.pausado && p.fake.playing.includes(ID(3)); }, { timeout: 20000, descricao: 'ID3 tocando' });
  await cel.esperarEstado((x) => !x.atual, { timeout: 30000, descricao: 'fila esgotada' });
  const cargas = amb.yt.pedidos.filter((p) => p.tipo === 'watch').map((p) => new URL(p.url).searchParams.get('v'));
  assert.deepEqual(cargas, [ID(1), ID(2), ID(3)]);
}));

test('e) autoplay que recarrega a página inteira para o recomendado também é contido', { timeout: 180000 }, () => comAmbiente('autoplay-full', async (amb) => {
  amb.yt.duracao = 2;
  amb.yt.modo = 'full';
  amb.yt.autoplay = 'sempre';
  amb.yt.atrasoAutoplay = 0;
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Hugo');
  await tocarTresMusicas(amb, cel);
  await ate(async () => { const p = await amb.paginaKtv(); return p && p.videoId === ID(3) && p.fake.playing.includes(ID(3)); }, { timeout: 60000, descricao: 'ID3 tocando apesar do autoplay' });
  await cel.esperarEstado((x) => !x.atual, { timeout: 30000, descricao: 'fila esgotada' });
  await espera(2500);
  const pg = await amb.paginaKtv();
  assert.ok(pg.pausado, `a aba KTV continua tocando (${pg.url})`);
}));

test('e) fila vazia mostra o modo ocioso com QR grande; novo pedido volta a tocar', { timeout: 150000 }, () => comAmbiente('ocioso', async (amb) => {
  amb.yt.duracao = 1.5;
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Ivo');
  let p = await ate(async () => { const x = await amb.painel(); return x?.ocioso ? x : null; }, { descricao: 'ocioso inicial' });
  assert.match(p.url, /#sala=/);

  await cel.colarLink(`https://youtu.be/${ID(1)}`);
  await ate(async () => (await amb.painel())?.tocando, { descricao: 'painel em modo tocando' });
  p = await amb.painel();
  assert.ok(p.qrPequeno.includes('<svg'));
  assert.equal(p.fila.length, 1);
  assert.match(p.fila[0], /Música dddddddddd1/);
  assert.match(p.fila[0], /pedido por Ivo/);

  // termina -> ocioso de novo, QR grande visível
  await ate(async () => (await amb.painel())?.ocioso, { timeout: 30000, descricao: 'volta ao ocioso' });
  assert.ok(await amb.ktv.locator('#ktv-root .qr-grande svg').isVisible());
  assert.ok(!(await amb.ktv.locator('#ktv-root .tocando').isVisible()));

  // ocioso + novo pedido => toca sem ninguém clicar de novo em "Iniciar"
  await cel.colarLink(`https://youtu.be/${ID(2)}`);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(2)), { timeout: 30000, descricao: 'ID2 tocando após ocioso' });
}));
