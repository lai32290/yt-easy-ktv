import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrl } from '../../extension/src/background/url.js';

const ID = 'dQw4w9WgXcQ';

test('parseUrl: formatos aceitos', () => {
  const casos = [
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=30`,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=10s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `  ${ID}  `,
  ];
  for (const c of casos) assert.equal(parseUrl(c), ID, c);
});

test('parseUrl: ignora &list= e outros parâmetros', () => {
  assert.equal(parseUrl(`https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=2`), ID);
  assert.equal(parseUrl(`https://www.youtube.com/watch?list=PLabc&v=${ID}`), ID);
});

test('parseUrl: IDs com - e _', () => {
  assert.equal(parseUrl('https://youtu.be/-TkjoqA5j_U'), '-TkjoqA5j_U');
});

test('parseUrl: rejeita o que não é vídeo', () => {
  const ruins = [
    '', '   ', null, undefined, 42, 'olá mundo',
    'https://www.youtube.com/watch?v=curto',
    'https://www.youtube.com/watch?v=' + ID + 'X',
    'https://www.youtube.com/playlist?list=PLabc123',
    'https://www.youtube.com/',
    'https://exemplo.com/watch?v=' + ID,
    'https://youtube.com.malicioso.com/watch?v=' + ID,
    'javascript:alert(1)',
    'ftp://youtu.be/' + ID,
    'ID_com_12_chars',
  ];
  for (const r of ruins) assert.equal(parseUrl(r), null, String(r));
});
