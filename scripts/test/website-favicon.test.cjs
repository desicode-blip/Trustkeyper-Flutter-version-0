const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../website/site');

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test('search and touch icons are square PNGs with explicit supported sizes', () => {
  for (const [name, size] of [['favicon.png', 96], ['apple-touch-icon.png', 180]]) {
    const source = fs.readFileSync(path.join(root, 'src', name));
    assert.deepEqual(pngSize(source), [size, size]);
    assert.ok(source.equals(fs.readFileSync(path.join(root, 'dist', name))));
  }
  const svg = fs.readFileSync(path.join(root, 'src/favicon.svg'), 'utf8');
  assert.match(svg, /width="96" height="96"/);
  assert.match(svg, /viewBox="-9 -12 72 72"/);
});

test('ICO fallback has valid 16, 32 and 48 pixel images', () => {
  const buffer = fs.readFileSync(path.join(root, 'src/favicon.ico'));
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  assert.equal(buffer.readUInt16LE(4), 3);
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    assert.equal(buffer[entry], size);
    assert.equal(buffer[entry + 1], size);
    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    assert.ok(offset + length <= buffer.length);
    assert.deepEqual(pngSize(buffer.subarray(offset, offset + length)), [size, size]);
  }
});

test('every public page declares the stable PNG favicon and proper Apple touch icon', () => {
  for (const name of ['index.html', 'for-property-agents/index.html', 'for-builders/index.html', 'contact-us/index.html', 'about-us/index.html', 'faqs/index.html', 'privacy-policy/index.html', 'terms-and-conditions/index.html', 'delete-account/index.html']) {
    const html = fs.readFileSync(path.join(root, 'dist', name), 'utf8');
    assert.ok(html.includes('<link rel="icon" type="image/png" sizes="96x96" href="/favicon.png">'), name);
    assert.ok(html.includes('href="/favicon.ico"'), name);
    assert.ok(html.includes('sizes="180x180" href="/apple-touch-icon.png"'), name);
    assert.ok(!html.includes('rel="apple-touch-icon" href="/favicon.svg"'), name);
  }
});
