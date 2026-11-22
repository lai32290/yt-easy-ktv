// web/protocol.js deve ser idêntico ao da extensão (rode `npm run sync` se falhar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lerArq = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('web/protocol.js é idêntico a extension/src/shared/protocol.js', () => {
  assert.equal(lerArq('web/protocol.js'), lerArq('extension/src/shared/protocol.js'));
});
