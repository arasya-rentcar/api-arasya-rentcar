import { Jimp, loadFont } from "jimp";

// "jimp/fonts" is an exports-only subpath this tsconfig's module resolution
// cannot see; it only holds the file paths of the bundled bitmap fonts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SANS_16_WHITE, SANS_32_WHITE } = require("jimp/fonts") as {
  SANS_16_WHITE: string;
  SANS_32_WHITE: string;
};

/**
 * Burns a caption band into the bottom of a photo, like the "GPS camera" apps
 * drivers know: who, when, where. Used for the arrival photo so the office
 * (and anyone it is forwarded to on WhatsApp) sees the driver name, time and
 * coordinates on the picture itself. Pure JS (no native deps on the VPS).
 *
 * The bundled bitmap fonts cover ASCII only, so callers pass plain text.
 * Returns a JPEG. Throws when the image cannot be decoded.
 */
export async function stampPhoto(input: Buffer, lines: string[]): Promise<Buffer> {
  const image = await Jimp.read(input);
  const { width, height } = image.bitmap;
  const big = Math.min(width, height) >= 720;
  const font = await loadFont(big ? SANS_32_WHITE : SANS_16_WHITE);
  const lineHeight = big ? 40 : 20;
  const pad = big ? 18 : 9;
  const text = lines.map(ascii).filter(Boolean);
  const bandHeight = Math.min(height, text.length * lineHeight + pad * 2);

  // Dark translucent band so white text stays readable on any background.
  const band = new Jimp({ width, height: bandHeight, color: 0x000000b3 });
  image.composite(band, 0, height - bandHeight);
  text.forEach((t, i) => {
    image.print({
      font,
      x: pad,
      y: height - bandHeight + pad + i * lineHeight,
      text: t,
      maxWidth: width - pad * 2,
      maxHeight: lineHeight,
    });
  });
  return image.getBuffer("image/jpeg", { quality: 82 });
}

/** Drop characters the bitmap font cannot draw (accents become plain letters). */
function ascii(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
