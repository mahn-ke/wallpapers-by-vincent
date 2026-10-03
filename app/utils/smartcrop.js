import smartcrop from 'smartcrop';
import sharp from 'sharp';

const imageOperations = {
  async open(input) {
    const image = sharp(input);
    const { width, height } = await image.metadata();
    return { width, height, image };
  },
  async resample(source, width, height) {
    return {
      width: Math.floor(width),
      height: Math.floor(height),
      image: source.image.clone()
    };
  },
  async getData(source) {
    const data = await source.image.clone()
      .resize(source.width, source.height, { kernel: sharp.kernel.cubic })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer();
    return new smartcrop.ImgData(source.width, source.height, data);
  }
};

export default {
  crop(input, options) {
    return smartcrop.crop(input, { ...options, imageOperations });
  }
};