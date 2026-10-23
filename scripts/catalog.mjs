import { readFile } from 'node:fs/promises';

export async function readCatalog() {
  const text = await readFile(new URL('../reference/50lys-list.txt', import.meta.url), 'utf8');
  const pattern = /^(.+?)\s+(\d{2})\s+(\d{2}\.\d)\s+([+-]\d{2})\s+(\d{2})\s+([+-]?\d+\.\d)\s+([+-]?\d+\.\d)\s+(\S+)\s+([+-]?\d+\.\d+)\s+([+-]?\d+\.\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+/;
  const stars = [{
    id: 'sol', catalogName: 'Sun', name: 'Sol', ra: 0, dec: 0,
    spectral: 'G2V', magnitude: -26.8, absoluteMagnitude: 4.83,
    distance: 0, notes: 'Our home system. Earth is represented at Sol on this interstellar scale.'
  }];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const [, catalogName, hours, minutes, degrees, arcminutes, , , spectral, magnitude, absoluteMagnitude, , distance] = match;
    const properName = line.slice(108, 123).trim();
    stars.push({
      id: catalogName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, ''),
      catalogName, name: properName || catalogName,
      ra: (Number(hours) + Number(minutes) / 60) * 15,
      dec: (Math.abs(Number(degrees)) + Number(arcminutes) / 60) * (degrees.startsWith('-') ? -1 : 1),
      spectral, magnitude: Number(magnitude), absoluteMagnitude: Number(absoluteMagnitude),
      distance: Number(distance), notes: line.slice(123).trim()
    });
  }
  if (stars.length !== 133) throw new Error(`Expected Sol + 132 catalog systems; parsed ${stars.length}.`);
  if (stars.some(star => !Number.isFinite(star.distance) || star.distance > 50)) throw new Error('Invalid catalog distance.');
  return stars;
}
