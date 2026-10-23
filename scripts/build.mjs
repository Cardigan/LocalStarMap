import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readCatalog } from './catalog.mjs';

const root = new URL('../', import.meta.url);
const stars = await readCatalog();
const references = JSON.parse(await readFile(new URL('reference/direction-stars.json', root), 'utf8'));
const referenceStars = references.stars.map(star => {
  const distance = 3261.56 / star.parallaxMas;
  return { ...star, distance, absoluteMagnitude: star.magnitude - 5 * Math.log10(distance / 3.26156) + 5, supplemental: true };
});
for (const markers of Object.values(references.directions)) {
  for (const marker of markers) {
    if (![...stars, ...referenceStars].some(star => star.id === marker.starId)) throw new Error(`Unknown direction reference: ${marker.starId}`);
  }
}
const data = `export const catalog = ${JSON.stringify(stars)};\nexport const referenceStars = ${JSON.stringify(referenceStars)};\nexport const directionSets = ${JSON.stringify(references.directions)};\n`;
await writeFile(new URL('src/data.js', root), data);
const [html, css, core, app] = await Promise.all(
  ['index.html', 'styles.css', 'src/space.js', 'src/app.js'].map(path => readFile(new URL(path, root), 'utf8'))
);
const script = `${data}\n${core}\n${app}`
  .replace(/^import .+?;\r?$/gm, '')
  .replace(/^export /gm, '')
  .replace(/<\/script/gi, '<\\/script');
const bundle = html
  .replace('<link rel="stylesheet" href="./styles.css">', `<style>${css}</style>`)
  .replace('<script type="module" src="./src/app.js"></script>', `<script type="module">${script}</script>`);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/index.html', root), bundle);
console.log(`Built dist\\index.html: ${stars.length} local systems + ${referenceStars.length} direction references; no external dependencies.`);
