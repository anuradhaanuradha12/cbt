import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const blobsDir = path.resolve('.wrangler/state/v3/r2/cbt-media/blobs');
const files = fs.readdirSync(blobsDir);

let processed = 0;
let errors = 0;

async function processBlobs() {
  for (const file of files) {
    const filePath = path.join(blobsDir, file);
    if (!fs.statSync(filePath).isFile()) continue;

    try {
      const inputBuffer = fs.readFileSync(filePath);
      const { data, info } = await sharp(inputBuffer).raw().toBuffer({ resolveWithObject: true });

      let modified = false;
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 210 && g > 210 && b > 210) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          modified = true;
        }
      }

      if (modified) {
        const outBuffer = await sharp(data, {
          raw: {
            width: info.width,
            height: info.height,
            channels: info.channels
          }
        }).webp({ lossless: true }).toBuffer();
        
        fs.writeFileSync(filePath, outBuffer);
      }

      processed++;
      if (processed % 1000 === 0) console.log(`Processed: ${processed}`);
    } catch (e) {
      errors++;
      // console.log(`Skipped or Error on ${file}: ${e.message}`);
    }
  }

  console.log(`Finished processing. Processed: ${processed}, Errors: ${errors}`);
}

processBlobs();
