import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CARD_DESIGNS } from '../src/card-designs.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetRoot = join(root, 'public', 'card-designs');
const catalog = JSON.parse(await readFile(join(assetRoot, 'catalog.json'), 'utf8'));
// Snapshot of the sorted filename + SHA256 records from the approved import
// manifest. Keep asset verification available in CI without private ZIP paths.
const approvedAssetManifestSha256 = '1131f266213a6270446918c6e77d912c30e5d63bafc6f5930489c28c4228629f';
const categoryIds = {
  nextap: ['N1','N2','N3','N4','N5','PN1','PN2','PN3','PN4','PN5','PN6','PN7'],
  animated: ['A1','A2','A3','A4','A7','A8','A9','A10','A11','A12','A13','A15','A16','A17','A18','A19','A20','Q1','Q2','Q3'],
  customized: ['C1','C2','C3','C4']
};

test('public and trusted server catalogs contain the same approved paired designs without plan restrictions', () => {
  assert.equal(catalog.length, 36);
  assert.equal(new Set(catalog.map(design => design.id)).size, 36);
  assert.deepEqual(catalog.map(({thumbnail, ...design}) => design), CARD_DESIGNS);
  for (const design of catalog) {
    assert.deepEqual(Object.keys(design).sort(), ['back','category','front','id','label','thumbnail','version']);
    assert.match(design.id, /^[A-Z]+[1-9][0-9]*$/);
    assert.match(design.version, /^[a-f0-9]{12}$/);
    assert.equal(design.label, design.id);
  }
  assert.equal(catalog.some(design => design.id === 'A6'), false, 'Unpaired artwork must not be substituted');
});

test('approved categories contain all 36 designs with Nextap first and natural code ordering', () => {
  assert.deepEqual(catalog.map(design => design.id), Object.values(categoryIds).flat());
  assert.equal(catalog[0].id, 'N1');
  for (const [category, ids] of Object.entries(categoryIds)) {
    assert.deepEqual(catalog.filter(design => design.category === category).map(design => design.id), ids);
  }
  assert.deepEqual(Object.fromEntries(Object.keys(categoryIds).map(category => [category, catalog.filter(design => design.category === category).length])),
    { nextap: 12, animated: 20, customized: 4 });
});

test('every front, back and thumbnail resolves to a complete WebP asset with an immutable paired filename', async () => {
  const expected = new Set(['catalog.json']);
  const hashes = [];
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
      hashes.push(name + '\0' + createHash('sha256').update(bytes).digest('hex'));
    }
  }
  assert.equal(expected.size, 109);
  assert.equal(hashes.length, 108);
  assert.equal(createHash('sha256').update(hashes.sort().join('\n')).digest('hex'), approvedAssetManifestSha256,
    'All 108 immutable asset bytes must match the approved original import manifest');
  assert.deepEqual((await readdir(assetRoot)).sort(), [...expected].sort(), 'Only approved web previews/catalog belong in public assets');
});
