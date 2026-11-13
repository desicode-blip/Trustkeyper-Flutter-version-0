const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.env.TRUSTKEYPER_SHARP_MODULE || 'sharp');

const source = path.resolve(__dirname, '../website/site/src');
const svg = fs.readFileSync(path.join(source, 'favicon.svg'));

async function generate() {
  for (const [name, size] of [['favicon.png', 96], ['apple-touch-icon.png', 180]]) {
    await sharp(svg, { density: 384 }).resize(size, size).png().toFile(path.join(source, name));
  }
  const sizes = [16, 32, 48];
  const images = await Promise.all(sizes.map(size => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + 16 * index;
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  fs.writeFileSync(path.join(source, 'favicon.ico'), Buffer.concat([header, ...images]));
  console.log('Generated square PNG, Apple touch icon, and multi-size ICO from the existing TrustKeyper mark.');
}

generate().catch(error => { console.error(error.message); process.exitCode = 1; });
