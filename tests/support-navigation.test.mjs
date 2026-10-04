import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const publicRoot = resolve(import.meta.dirname, '../public');
const pages = ['index.html', 'privacy.html', 'terms.html', 'security.html', 'data-deletion.html', 'client-login.html'];
const aliases = {'/':'index.html', '/client-login':'client-login.html', '/order':'order.html', '/client-dashboard':'client-dashboard.html'};
const decode = value => value.replace(/&amp;/g, '&');
const read = file => readFile(resolve(publicRoot, file), 'utf8');

test('home and support-page navigation resolves to existing pages and anchors', async () => {
  let checked = 0;
  for (const page of pages) {
    const html = await read(page);
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
    assert.equal(new Set(ids).size, ids.length, page + ' duplicate IDs');
    for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
      const href = decode(match[1]);
      const url = new URL(href, 'https://nextap.test/' + page);
      if (url.origin !== 'https://nextap.test') continue;
      const file = aliases[url.pathname] || url.pathname.slice(1);
      const target = file === page ? html : await read(file);
      if (url.hash) {
        const id = decodeURIComponent(url.hash.slice(1));
        const targetIds = Array.from(target.matchAll(/\bid="([^"]+)"/g), entry => entry[1]);
        assert.ok(targetIds.includes(id), page + ': missing destination ' + href);
      }
      checked++;
    }
  }
  assert.ok(checked > 60, 'Navigation check must cover links across all support pages');
});

test('all referenced local policy and login styles, scripts and images resolve', async () => {
  for (const page of pages.slice(1)) {
    const html = await read(page);
    for (const match of html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(decode(match[1]), 'https://nextap.test/' + page);
      if (url.origin !== 'https://nextap.test') continue;
      const body = await read(url.pathname.slice(1));
      assert.ok(body.length, page + ': empty local asset ' + url.pathname);
    }
  }
});
