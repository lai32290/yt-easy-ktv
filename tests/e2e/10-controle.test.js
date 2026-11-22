// Critério (issue #3): a aba "Controle" do celular comanda o player da aba KTV — tocar/pausar,
// do início, -10s/+10s, mudo, volume -/+ e próxima — e o celular mostra o estado real.
// O volume/mudo vão pela API do player (como o YouTube): continuam valendo na música seguinte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';

const ID = (n) => `kkkkkkkkkk${n}`;

async function prepararDuasMusicas(amb, { duracao = 60 } = {}) {
  amb.yt.duracao = duracao;
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Lia');
  await cel.colarLink(`https://youtu.be/${ID(1)}`);
  await cel.esperarEstado((s) => s.atual?.videoId === ID(1));
  await cel.colarLink(`https://youtu.be/${ID(2)}`);
  await cel.esperarEstado((s) => s.fila.length === 1);
  await ate(async () => { const p = await amb.paginaKtv(); return p?.videoId === ID(1) && !p.pausado && p.tempo > 0.5; },
    { timeout: 30000, descricao: 'música 1 tocando' });
  await cel.aba('controle');
  return cel;
}

const botao = (cel, nome) => cel.page.getByTestId(`ctl-${nome}`);
const texto = async (cel, testid) => ((await cel.page.getByTestId(testid).textContent()) || '').trim();
const esperarPagina = (amb, pred, descricao) => ate(async () => { const p = await amb.paginaKtv(); return p && pred(p) && p; }, { descricao });
const esperarCelular = (cel, pred, descricao) => cel.esperarEstado((s) => pred(s.player), { descricao });

test('controle: tocar/pausar, saltos, do início, mudo, volume e próxima', { timeout: 180000 }, () => comAmbiente('controle', async (amb) => {
  const cel = await prepararDuasMusicas(amb);
  assert.match(await texto(cel, 'ctl-titulo'), new RegExp(`Música ${ID(1)}`));
  for (const n of ['restart', 'back', 'forward', 'playpause', 'voldown', 'mute', 'volup', 'skip']) {
    assert.ok(await botao(cel, n).isEnabled(), `botão ${n} deveria estar habilitado com música tocando`);
  }

  // Pausar / Tocar
  await botao(cel, 'playpause').click();
  await esperarPagina(amb, (p) => p.pausado, 'vídeo pausado');
  await esperarCelular(cel, (pl) => pl.pausado, 'celular vê pausado');
  await ate(async () => (await texto(cel, 'ctl-playpause')).includes('Tocar'), { descricao: 'botão vira "Tocar"' });
  await botao(cel, 'playpause').click();
  await esperarPagina(amb, (p) => !p.pausado, 'vídeo tocando de novo');
  await ate(async () => (await texto(cel, 'ctl-playpause')).includes('Pausar'), { descricao: 'botão vira "Pausar"' });

  // +10s / -10s / do início
  const t0 = (await amb.paginaKtv()).tempo;
  await botao(cel, 'forward').click();
  const p1 = await esperarPagina(amb, (p) => p.tempo >= t0 + 9, '+10s');
  await botao(cel, 'back').click();
  await esperarPagina(amb, (p) => p.tempo < p1.tempo - 5, '-10s');
  await botao(cel, 'forward').click();
  await botao(cel, 'forward').click();
  await esperarPagina(amb, (p) => p.tempo >= 15, 'dois saltos');
  await botao(cel, 'restart').click();
  await esperarPagina(amb, (p) => p.tempo < 5, 'do início');

  // Volume - / + (pela API do player: o volume do YouTube, não o do <video> normalizado)
  await botao(cel, 'voldown').click();
  await esperarPagina(amb, (p) => p.fake.api.volume === 90, 'API do player com volume 90');
  await esperarCelular(cel, (pl) => pl.volume === 90, 'celular vê 90%');
  await ate(async () => (await texto(cel, 'ctl-volume')) === 'Volume: 90%', { descricao: 'texto do volume 90%' });
  await botao(cel, 'voldown').click();
  await esperarPagina(amb, (p) => p.fake.api.volume === 80, 'volume 80');
  await botao(cel, 'volup').click();
  await esperarPagina(amb, (p) => p.fake.api.volume === 90, 'volume 90 de novo');

  // Mudo / Ativar som
  await botao(cel, 'mute').click();
  await esperarPagina(amb, (p) => p.fake.api.mudo && p.mudo, 'mudo');
  await esperarCelular(cel, (pl) => pl.mudo, 'celular vê mudo');
  await ate(async () => (await texto(cel, 'ctl-mute')).includes('Ativar som'), { descricao: 'botão vira "Ativar som"' });
  assert.equal(await texto(cel, 'ctl-volume'), 'Volume: mudo');
  await botao(cel, 'mute').click();
  await esperarPagina(amb, (p) => !p.fake.api.mudo && !p.mudo, 'som de volta');
  await esperarCelular(cel, (pl) => !pl.mudo, 'celular vê com som');

  // Mudo + Próxima: a música 2 começa ainda muda e com o volume escolhido (o player não desfaz).
  await botao(cel, 'mute').click();
  await esperarPagina(amb, (p) => p.fake.api.mudo, 'mudo antes de pular');
  await botao(cel, 'skip').click();
  const p2 = await esperarPagina(amb, (p) => p.videoId === ID(2) && !p.pausado && p.tempo > 0.5, 'música 2 tocando');
  assert.equal(p2.mudo, true, 'a música seguinte deveria continuar muda');
  assert.equal(p2.fake.api.volume, 90);
  const s = await cel.esperarEstado((x) => x.atual?.videoId === ID(2) && x.player.mudo, { descricao: 'celular: música 2 muda' });
  assert.equal(s.player.volume, 90);
  assert.equal(s.player.pausado, false);
}));

test('controle: sem a API do player, o som vai direto no <video>', { timeout: 120000 }, () => comAmbiente('controle-sem-api', async (amb) => {
  amb.yt.api = false;
  const cel = await prepararDuasMusicas(amb);
  const v0 = (await amb.paginaKtv()).volume;
  await botao(cel, 'voldown').click();
  await esperarPagina(amb, (p) => p.volume < v0 - 0.05, 'volume do <video> baixou');
  await botao(cel, 'mute').click();
  await esperarPagina(amb, (p) => p.mudo, '<video> mudo');
  await esperarCelular(cel, (pl) => pl.mudo, 'celular vê mudo');
  await botao(cel, 'playpause').click();
  await esperarPagina(amb, (p) => p.pausado, 'pausado');
}));
