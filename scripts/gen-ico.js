const pngToIco = require('png-to-ico');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function generateIco() {
  const inputPath = path.join(__dirname, '../build/yjtp.png');
  const outputPath = path.join(__dirname, '../build/icon.ico');
  
  // 获取原图尺寸
  const metadata = await sharp(inputPath).metadata();
  console.log(`Original size: ${metadata.width}x${metadata.height}`);
  
  // 计算正方形裁剪区域（居中裁剪）
  const size = Math.min(metadata.width, metadata.height);
  const left = Math.floor((metadata.width - size) / 2);
  const top = Math.floor((metadata.height - size) / 2);
  
  console.log(`Cropping to ${size}x${size} from (${left}, ${top})`);
  
  // 裁剪成正方形并调整大小到 256x256
  const squareBuffer = await sharp(inputPath)
    .extract({ left, top, width: size, height: size })
    .resize(256, 256, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  
  // 生成 ico
  const icoBuffer = await pngToIco(squareBuffer);
  fs.writeFileSync(outputPath, icoBuffer);
  
  const stats = fs.statSync(outputPath);
  console.log(`Generated ${outputPath} (${Math.round(stats.size / 1024)} KB)`);
}

generateIco().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
