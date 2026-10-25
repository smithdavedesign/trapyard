// The score card's share image: a 1200×630 PNG drawn with Node built-ins only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { SCENARIO_SET, TRAPS } from '../src/scenarios.js';
import { COLORS, IMAGE, LAYOUT, glyphFor, pillBox, shareImage, textWidth } from '../src/share-image.js';

/** Minimal PNG reader: checks the signature and every chunk's CRC, returns size and an RGB pixel getter. */
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  let at = 8;
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    const crc = buf.readUInt32BE(at + 8 + length);
    assert.equal(crc32(buf.subarray(at + 4, at + 8 + length)), crc, `${type} CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.equal(chunks[0].type, 'IHDR');
  assert.equal(chunks.at(-1).type, 'IEND');
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], '8-bit RGB, deflate, no filter method, no interlace');
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = 1 + width * 3;
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y++) assert.equal(raw[y * stride], 0, 'every scanline uses filter 0');
  const pixel = (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
  return { width, height, pixel, chunks };
}

const card = (statuses, state = 'finished') => {
  const traps = TRAPS.map((t, i) => ({ class: t.class, title: t.title, technique: t.technique, status: statuses ? statuses[i] : null }));
  const count = (s) => traps.filter((t) => t.status === s).length;
  return {
    state,
    scenarioSet: { ...SCENARIO_SET },
    startedAt: '2026-10-25T10:00:00.000Z',
    summary: state === 'finished' ? { fell: count('fell'), held: count('held'), notReached: count('not_reached'), total: 4 } : null,
    traps,
  };
};

/** A point inside a pill's padding, away from its label. */
const pillPixel = (img, i) => {
  const box = pillBox(i);
  return img.pixel(box.x + 3, box.y + 3);
};

test('the share image is a valid 1200×630 RGB PNG', () => {
  const img = decodePng(shareImage(card(['fell', 'held', 'not_reached', 'fell'])));
  assert.deepEqual([img.width, img.height], [IMAGE.width, IMAGE.height]);
  assert.deepEqual([IMAGE.width, IMAGE.height], [1200, 630], 'the size link previews expect');
  assert.deepEqual(img.pixel(0, 0), COLORS.background);
});

test('each trap row has a pill in its status colour', () => {
  const img = decodePng(shareImage(card(['fell', 'held', 'not_reached', 'fell'])));
  assert.deepEqual(pillPixel(img, 0), COLORS.fell);
  assert.deepEqual(pillPixel(img, 1), COLORS.held);
  assert.deepEqual(pillPixel(img, 2), COLORS.not_reached);
  assert.deepEqual(pillPixel(img, 3), COLORS.fell);
  // The label is drawn inside the pill: somewhere in it there is text-coloured (white) ink.
  const box = pillBox(0);
  let ink = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) if (img.pixel(x, y).join() === COLORS.pillText.join()) ink++;
  }
  assert.ok(ink > 50, 'the pill carries a label');
});

test('a running card draws every pill as pending', () => {
  const img = decodePng(shareImage(card(null, 'running')));
  for (let i = 0; i < 4; i++) assert.deepEqual(pillPixel(img, i), COLORS.pending);
  assert.notDeepEqual(COLORS.pending, COLORS.not_reached, 'pending and not reached look different');
});

test('the image is deterministic, and a different result gives different bytes', () => {
  const a = shareImage(card(['fell', 'fell', 'fell', 'fell']));
  assert.ok(a.equals(shareImage(card(['fell', 'fell', 'fell', 'fell']))));
  assert.ok(!a.equals(shareImage(card(['held', 'fell', 'fell', 'fell']))));
  assert.ok(a.length < 100_000, `small enough to serve on every preview (${a.length} bytes)`);
});

test('text: lowercase is drawn as uppercase and unknown characters as ?', () => {
  assert.equal(glyphFor('a'), glyphFor('A'));
  assert.equal(glyphFor('✓'), glyphFor('?'));
  assert.notEqual(glyphFor('A'), glyphFor('?'));
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,:/()·') assert.notEqual(glyphFor(ch), undefined);
});

test('layout: every trap title fits before its pill, and the headline fits the width', () => {
  for (const t of TRAPS) {
    assert.ok(LAYOUT.margin + textWidth(t.title, LAYOUT.rowScale) < pillBox(0).x - 10, `${t.title} fits`);
  }
  assert.ok(LAYOUT.margin + textWidth('4 OF 4 TRAPS FELL', LAYOUT.headlineScale) < IMAGE.width - LAYOUT.margin);
  assert.ok(textWidth('NOT REACHED', LAYOUT.rowScale) < pillBox(0).w - 8, 'the longest label fits in a pill');
  const last = pillBox(TRAPS.length - 1);
  assert.ok(last.y + last.h < LAYOUT.footerY, 'rows end above the footer');
});
