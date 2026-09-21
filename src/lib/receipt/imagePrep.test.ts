import { JPEG_QUALITY, MAX_IMAGE_LONG_EDGE, planResize, prepareReceiptImage, type ManipulateImage } from './imagePrep';

describe('planResize', () => {
  it('defaults to a 1568 px long edge', () => {
    expect(MAX_IMAGE_LONG_EDGE).toBe(1568);
  });

  it('scales a tall receipt so its height is the cap and keeps the aspect ratio', () => {
    expect(planResize({ width: 1000, height: 4000 })).toEqual({ width: 392, height: 1568 });
  });

  it('scales a wide photo by its width', () => {
    expect(planResize({ width: 4032, height: 3024 })).toEqual({ width: 1568, height: 1176 });
  });

  it('leaves a photo alone when the long edge is already within the cap', () => {
    expect(planResize({ width: 1568, height: 900 })).toEqual({ width: 1568, height: 900 });
    expect(planResize({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });

  it('never scales an edge below one pixel', () => {
    expect(planResize({ width: 1, height: 100000 })).toEqual({ width: 1, height: 1568 });
  });

  it('honors a custom cap', () => {
    expect(planResize({ width: 2000, height: 1000 }, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it('rejects sizes that are not positive finite numbers', () => {
    expect(() => planResize({ width: 0, height: 100 })).toThrow();
    expect(() => planResize({ width: NaN, height: 100 })).toThrow();
    expect(() => planResize({ width: 100, height: 100 }, 0)).toThrow();
  });
});

describe('prepareReceiptImage', () => {
  const manipulate = jest.fn<ReturnType<ManipulateImage>, Parameters<ManipulateImage>>(async ({ uri, resize }) => ({
    uri: `${uri}.jpg`,
    width: resize?.width ?? 0,
    height: resize?.height ?? 0,
  }));

  beforeEach(() => manipulate.mockClear());

  it('resizes an oversized photo and compresses it', async () => {
    const result = await prepareReceiptImage({ uri: 'file:///r', width: 3000, height: 6000 }, manipulate);
    expect(manipulate).toHaveBeenCalledWith({
      uri: 'file:///r',
      resize: { width: 784, height: 1568 },
      compress: JPEG_QUALITY,
    });
    expect(result.uri).toBe('file:///r.jpg');
  });

  it('still re-encodes a small photo but skips the resize', async () => {
    await prepareReceiptImage({ uri: 'file:///s', width: 800, height: 600 }, manipulate);
    expect(manipulate).toHaveBeenCalledWith({ uri: 'file:///s', resize: null, compress: JPEG_QUALITY });
  });
});
