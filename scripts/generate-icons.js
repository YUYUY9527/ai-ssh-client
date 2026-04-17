const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

// 或者使用 sharp 来调整尺寸
const sharp = require('sharp');

async function generateMultiSizeIco() {
  const inputPath = path.join(__dirname, '../build/icon-1024.png');
  const outputPath = path.join(__dirname, '../build/icon.ico');
  
  // 生成多种尺寸的 PNG
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const tempBuffers = [];
  
  for (const size of sizes) {
    const buffer = await sharp(inputPath)
      .resize(size, size, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    tempBuffers.push(buffer);
  }
  
  // 合并成 ico
  const icoBuffer = await pngToIco(tempBuffers);
  fs.writeFileSync(outputPath, icoBuffer);
  console.log(`Generated ${outputPath} with sizes: ${sizes.join(', ')}`);
}

generateMultiSizeIco().catch(console.error);
