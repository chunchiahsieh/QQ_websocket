import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

test('shipped LINE SVG matches the contact link and its QR matrix decodes correctly', async () => {
  const url = 'https://line.me/ti/p/5LfC7875q4';
  const options = { errorCorrectionLevel: 'M', margin: 4, width: 256 };
  const expected = await QRCode.toString(url, { ...options, type: 'svg' });
  const actual = await readFile(new URL('../public/contact-line.svg', import.meta.url), 'utf8');
  assert.equal(actual.trim(), expected.trim());
  const { modules } = QRCode.create(url, options);
  const scale = 8, margin = 4, size = (modules.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) {
    if (!modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
  }
  assert.equal(jsQR(pixels, size, size)?.data, url);
});
