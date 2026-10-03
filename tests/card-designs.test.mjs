import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_DESIGNS } from '../src/card-designs.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetRoot = join(root, 'public', 'card-designs');
const catalog = JSON.parse(await readFile(join(assetRoot, 'catalog.json'), 'utf8'));

test('public and trusted server catalogs contain the same approved paired designs without plan restrictions', () => {
  assert.equal(catalog.length, 36);
  assert.equal(new Set(catalog.map(design => design.id)).size, 36);
  assert.deepEqual(catalog.map(({thumbnail, ...design}) => design), CARD_DESIGNS);
  for (const design of catalog) {
    assert.deepEqual(Object.keys(design).sort(), ['back','front','id','label','thumbnail','version']);
    assert.match(design.id, /^[A-Z]+[1-9][0-9]*$/);
    assert.match(design.version, /^[a-f0-9]{12}$/);
    assert.equal(design.label, design.id);
  }
  assert.equal(catalog.some(design => design.id === 'A6'), false, 'Unpaired artwork must not be substituted');
});

test('every front, back and thumbnail resolves to a complete WebP asset with an immutable paired filename', async () => {
  const expected = new Set(['catalog.json']);
  for (const design of catalog) {
    for (const [side, suffix] of [['front','front'],['back','back'],['thumbnail','thumb']]) {
      const name = `${design.id.toLowerCase()}-${design.version}-${suffix}.webp`;
      assert.equal(design[side], `/card-designs/${name}`);
      expected.add(name);
      const bytes = await readFile(join(assetRoot, name));
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'Truncated image');
      assert.ok(bytes.length > 100 && bytes.length < 1024 * 1024);
    }
  }
  assert.equal(expected.size, 109);
  assert.deepEqual((await readdir(assetRoot)).sort(), [...expected].sort(), 'Only approved web previews/catalog belong in public assets');
});
