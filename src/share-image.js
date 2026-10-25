// The share images: a score card's and the site's own (siteImage, below), 1200×630 PNGs (the size
// link previews use), drawn with Node built-ins only. A PNG is a signature plus CRC-checked chunks;
// the pixels are deflated RGB rows. Text uses a 5×7 bitmap font, scaled up, in capitals.
//
//   TRAPYARD SCORE CARD
//   4 OF 4 TRAPS FELL                                      (headline)
//   0 HELD · 0 NOT REACHED
//   FOLLOWED A PLANTED INSTRUCTION               [ FELL ]  (one row per trap, pill in status colour)
//   …
//   SCENARIO SET CORE 2026.10.0 · RUN 2026-10-25
//   A RESULT ON THE TRAPYARD RANGE, NOT A CERTIFICATION

import { crc32, deflateSync } from 'node:zlib';

export const IMAGE = { width: 1200, height: 630 };

export const COLORS = {
  background: [255, 255, 255],
  text: [26, 26, 26],
  muted: [85, 85, 85],
  rule: [221, 221, 221],
  pillText: [255, 255, 255],
  fell: [179, 38, 30],
  held: [30, 123, 52],
  not_reached: [119, 119, 119],
  pending: [165, 165, 165],
};

export const LAYOUT = {
  margin: 60,
  titleY: 50,
  titleScale: 4,
  headlineY: 100,
  headlineScale: 9,
  subY: 185,
  subScale: 3,
  rowTop: 245,
  rowGap: 70,
  rowScale: 4,
  pill: { x: 820, w: 320, h: 48 },
  ruleY: 525,
  footerY: 545,
  footerGap: 35,
  footerScale: 3,
};

const LABEL = { fell: 'FELL', held: 'HELD', not_reached: 'NOT REACHED' };

// 5×7 glyphs, one string of 5 bits per row, top to bottom.
const FONT_SOURCE = {
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 10001 11001 10101 10011 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110',
  1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11111 00010 00100 00010 00001 10001 01110',
  4: '00010 00110 01010 10010 11111 00010 00010',
  5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110',
  7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100',
  ' ': '00000 00000 00000 00000 00000 00000 00000',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ',': '00000 00000 00000 00000 01100 00100 01000',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  '/': '00000 00001 00010 00100 01000 10000 00000',
  '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000',
  '·': '00000 00000 01100 01100 00000 00000 00000',
  '?': '01110 10001 00001 00010 00100 00000 00100',
};

const FONT = new Map(Object.entries(FONT_SOURCE).map(([ch, rows]) => [ch, rows.split(' ').map((r) => parseInt(r, 2))]));

/** The glyph drawn for `ch`: capitals for letters, `?` for anything the font lacks. */
export const glyphFor = (ch) => FONT.get(ch.toUpperCase()) ?? FONT.get('?');

/** Width in pixels of `text` at `scale` (glyphs are 5 wide with a 1-column gap). */
export const textWidth = (text, scale) => (text.length === 0 ? 0 : [...text].length * 6 * scale - scale);

/** Where trap row `index`'s status pill sits. */
export function pillBox(index) {
  const { pill, rowTop, rowGap, rowScale } = LAYOUT;
  const textTop = rowTop + index * rowGap;
  return { x: pill.x, y: textTop - (pill.h - 7 * rowScale) / 2, w: pill.w, h: pill.h };
}

/** An RGB canvas stored as PNG scanlines: each row is a filter byte (0, none) and then its pixels. */
function canvas(width, height, background) {
  const stride = 1 + width * 3;
  const data = Buffer.alloc(stride * height);
  const fill = (x0, y0, w, h, [r, g, b]) => {
    const x1 = Math.min(width, x0 + w);
    const y1 = Math.min(height, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) {
        const at = y * stride + 1 + x * 3;
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
      }
    }
  };
  fill(0, 0, width, height, background);
  const text = (x, y, string, scale, color) => {
    let left = x;
    for (const ch of string) {
      const glyph = glyphFor(ch);
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row] & (1 << (4 - col))) fill(left + col * scale, y + row * scale, scale, scale, color);
        }
      }
      left += 6 * scale;
    }
  };
  return { data, fill, text };
}

function chunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, crc]);
}

function encodePng(width, height, scanlines) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit depth, RGB, deflate, standard filtering, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Where siteImage() puts things: a big name, the tagline, one row per trap, a footer. */
export const SITE_LAYOUT = {
  nameY: 60,
  nameScale: 12,
  taglineY: 175,
  taglineGap: 50,
  taglineScale: 5,
  rowTop: 310,
  rowGap: 50,
  rowScale: 4,
  bullet: 28,
};

/**
 * The share image of the site itself (/og.png, every public page's og:image), 1200×630:
 *
 *   TRAPYARD
 *   A FREE TEST RANGE THAT TRIES
 *   TO TRICK YOUR AI AGENT
 *   ■ FOLLOWED A PLANTED INSTRUCTION      (one row per trap, a bullet in the "fell" colour)
 *   …
 *   PLANTED INJECTIONS · FAKE TOOLS · CANARY SECRETS
 *   FREE SCORE CARDS · NOT A CERTIFICATION
 *
 * Pure: always the same bytes.
 */
export function siteImage(traps) {
  const { width, height } = IMAGE;
  const L = LAYOUT;
  const S = SITE_LAYOUT;
  const c = canvas(width, height, COLORS.background);
  c.text(L.margin, S.nameY, 'TRAPYARD', S.nameScale, COLORS.text);
  c.text(L.margin, S.taglineY, 'A FREE TEST RANGE THAT TRIES', S.taglineScale, COLORS.text);
  c.text(L.margin, S.taglineY + S.taglineGap, 'TO TRICK YOUR AI AGENT', S.taglineScale, COLORS.text);
  traps.forEach((trap, i) => {
    const top = S.rowTop + i * S.rowGap;
    c.fill(L.margin, top, S.bullet, S.bullet, COLORS.fell);
    c.text(L.margin + S.bullet + 20, top + (S.bullet - 7 * S.rowScale) / 2, trap.title, S.rowScale, COLORS.text);
  });
  c.fill(L.margin, L.ruleY, width - 2 * L.margin, 2, COLORS.rule);
  c.text(L.margin, L.footerY, 'PLANTED INJECTIONS · FAKE TOOLS · CANARY SECRETS', L.footerScale, COLORS.muted);
  c.text(L.margin, L.footerY + L.footerGap, 'FREE SCORE CARDS · NOT A CERTIFICATION', L.footerScale, COLORS.muted);
  return encodePng(width, height, c.data);
}

/** The share image for a card view (see cardView() in gauntlet.js). Pure: same card, same bytes. */
export function shareImage(card) {
  const { width, height } = IMAGE;
  const L = LAYOUT;
  const c = canvas(width, height, COLORS.background);
  const s = card.summary;
  c.text(L.margin, L.titleY, 'TRAPYARD SCORE CARD', L.titleScale, COLORS.muted);
  c.text(L.margin, L.headlineY, s ? `${s.fell} OF ${s.total} TRAPS FELL` : 'IN PROGRESS', L.headlineScale, COLORS.text);
  c.text(L.margin, L.subY, s ? `${s.held} HELD · ${s.notReached} NOT REACHED` : 'THE SCORE APPEARS WHEN THE RUN ENDS', L.subScale, COLORS.muted);
  card.traps.forEach((trap, i) => {
    const box = pillBox(i);
    const textTop = L.rowTop + i * L.rowGap;
    c.text(L.margin, textTop, trap.title, L.rowScale, COLORS.text);
    c.fill(box.x, box.y, box.w, box.h, trap.status ? COLORS[trap.status] : COLORS.pending);
    const label = trap.status ? LABEL[trap.status] : 'PENDING';
    c.text(box.x + Math.floor((box.w - textWidth(label, L.rowScale)) / 2), textTop, label, L.rowScale, COLORS.pillText);
  });
  c.fill(L.margin, L.ruleY, width - 2 * L.margin, 2, COLORS.rule);
  const set = card.scenarioSet;
  c.text(L.margin, L.footerY, `SCENARIO SET ${set.id} ${set.version} · RUN ${card.startedAt.slice(0, 10)}`, L.footerScale, COLORS.muted);
  c.text(L.margin, L.footerY + L.footerGap, 'A RESULT ON THE TRAPYARD RANGE, NOT A CERTIFICATION', L.footerScale, COLORS.muted);
  return encodePng(width, height, c.data);
}
