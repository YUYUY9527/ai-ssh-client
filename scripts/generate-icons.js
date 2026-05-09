const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function generateMultiSizeIco() {
  const inputPath = path.join(__dirname, '../build/icon.svg');
  const outputPngPath = path.join(__dirname, '../build/icon-1024.png');
  const outputIcoPath = path.join(__dirname, '../build/icon.ico');
  const outputFaviconPath = path.join(__dirname, '../public/favicon.png');

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing source icon: ${inputPath}`);
  }

  await fs.promises.mkdir(path.dirname(outputFaviconPath), { recursive: true });

  await sharp(inputPath)
    .resize(1024, 1024, { kernel: 'lanczos3' })
    .png()
    .toFile(outputPngPath);

  await sharp(inputPath)
    .resize(256, 256, { kernel: 'lanczos3' })
    .png()
    .toFile(outputFaviconPath);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const tempBuffers = [];

  for (const size of sizes) {
    const buffer = await sharp(inputPath)
      .resize(size, size, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    tempBuffers.push(buffer);
  }

  const icoBuffer = await pngToIco(tempBuffers);
  fs.writeFileSync(outputIcoPath, icoBuffer);

  console.log(`Generated ${outputPngPath}`);
  console.log(`Generated ${outputFaviconPath}`);
  console.log(`Generated ${outputIcoPath} with sizes: ${sizes.join(', ')}`);
}

generateMultiSizeIco().catch(console.error);
