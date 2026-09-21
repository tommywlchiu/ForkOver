/**
 * On-device image prep before upload. See SPEC.md section 7.6.
 *
 * The pure sizing rule lives here; the native resize and JPEG encode are
 * injected, so the screen that captures the photo (M3) wires in
 * `expo-image-manipulator` and this file stays testable without native code.
 */

/** Long-edge cap in pixels. Check the vision docs for the chosen model before changing it. */
export const MAX_IMAGE_LONG_EDGE = 1568;

/** JPEG quality, 0 to 1. */
export const JPEG_QUALITY = 0.85;

export type ImageSize = { width: number; height: number };

/**
 * Returns the size the photo should be resized to so its long edge is at most
 * `maxLongEdge`, keeping the aspect ratio. Photos already small enough come
 * back unchanged and are never scaled up.
 */
export function planResize(size: ImageSize, maxLongEdge: number = MAX_IMAGE_LONG_EDGE): ImageSize {
  const { width, height } = size;
  if (![width, height, maxLongEdge].every((n) => Number.isFinite(n) && n >= 1)) {
    throw new Error(`planResize: sizes must be finite numbers of at least 1, got ${width}x${height} (max ${maxLongEdge})`);
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type ManipulatedImage = { uri: string } & ImageSize;

/**
 * Resizes (when `resize` is given) and JPEG-encodes at the given quality. The
 * app implements this with `manipulateAsync` from `expo-image-manipulator`.
 */
export type ManipulateImage = (args: {
  uri: string;
  resize: ImageSize | null;
  compress: number;
}) => Promise<ManipulatedImage>;

/**
 * Prepares a receipt photo for upload: at most `maxLongEdge` px on the long
 * edge, always re-encoded as JPEG so HEIC and PNG input come out uniform.
 */
export async function prepareReceiptImage(
  source: { uri: string } & ImageSize,
  manipulate: ManipulateImage,
  maxLongEdge: number = MAX_IMAGE_LONG_EDGE,
): Promise<ManipulatedImage> {
  const target = planResize(source, maxLongEdge);
  const needsResize = target.width !== source.width || target.height !== source.height;
  return manipulate({
    uri: source.uri,
    resize: needsResize ? target : null,
    compress: JPEG_QUALITY,
  });
}
