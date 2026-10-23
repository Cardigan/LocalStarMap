import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function initialTheme(search, prefersDark) {
  let theme;
  runInNewContext(bootstrap, {
    URLSearchParams,
    window: { location: { search }, matchMedia: () => ({ matches: prefersDark }) },
    document: { documentElement: { setAttribute: (name, value) => { if (name === 'data-theme') theme = value; } } }
  });
  return theme;
}

test('initial theme is dark regardless of the operating system preference', () => {
  assert.equal(initialTheme('', false), 'dark');
  assert.equal(initialTheme('', true), 'dark');
});

test('explicit light and dark theme overrides are preserved', () => {
  assert.equal(initialTheme('?scoutTheme=light', true), 'light');
  assert.equal(initialTheme('?scoutTheme=dark', false), 'dark');
});
