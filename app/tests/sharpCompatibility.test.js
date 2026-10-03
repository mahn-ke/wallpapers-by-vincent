import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import SmartCrop from '../utils/smartcrop.js';

for (const format of ['jpeg', 'png', 'transparent-png']) {
  test(`smartcrop crops ${format} with the selected Sharp version`, async () => {
    const sourceWidth = 320;
    const sourceHeight = 240;
    const transparent = format === 'transparent-png';
    const input = await sharp({
      create: {
        width: sourceWidth,
        height: sourceHeight,
        channels: transparent ? 4 : 3,
        background: { r: 80, g: 140, b: 220, alpha: transparent ? 0.5 : 1 }
      }
    }).toFormat(format === 'jpeg' ? 'jpeg' : 'png').toBuffer();
    const oriented = await sharp(input).rotate().toBuffer();
    const { topCrop } = await SmartCrop.crop(oriented, { width: 160, height: 90 });

    assert.ok(Number.isFinite(topCrop.x));
    assert.ok(Number.isFinite(topCrop.y));
    assert.ok(topCrop.width > 0 && topCrop.height > 0);
    assert.ok(topCrop.x >= 0 && topCrop.y >= 0);
    assert.ok(topCrop.x + topCrop.width <= sourceWidth);
    assert.ok(topCrop.y + topCrop.height <= sourceHeight);

    const output = await sharp(oriented).extract({
      left: Math.floor(topCrop.x),
      top: Math.floor(topCrop.y),
      width: Math.floor(topCrop.width),
      height: Math.floor(topCrop.height)
    }).resize(160, 90).jpeg().toBuffer();
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 90);
    assert.equal(metadata.format, 'jpeg');
  });
}