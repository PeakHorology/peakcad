import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const electronDir = join(root, "electron");
const publicPeakcadDir = join(root, "apps", "web", "public", "assets", "peakcad");
const publicDir = join(root, "apps", "web", "public");
const sourceLogo = join(publicPeakcadDir, "peakcad-logo.png");
const appIconPng = join(publicPeakcadDir, "peakcad-app-icon.png");
const faviconIco = join(publicDir, "favicon.ico");
const iconPng = join(buildDir, "icon.png");
const iconIco = join(buildDir, "icon.ico");
const electronIconIco = join(electronDir, "icon.ico");
// Windows shell uses 16/32 for taskbar pins; keep full set for exe resources.
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

await mkdir(buildDir, { recursive: true });
await mkdir(publicPeakcadDir, { recursive: true });

const metadata = await sharp(sourceLogo).metadata();
const width = metadata.width ?? 0;
const height = metadata.height ?? 0;
const cropSize = Math.min(width, height);
const left = Math.max(0, Math.floor((width - cropSize) / 2));
const top = Math.max(0, Math.floor((height - cropSize) / 2));

// Square PeakCAD mark on the logo's dark field — readable at 16px taskbar size.
const master512 = await sharp(sourceLogo)
  .extract({ left, top, width: cropSize, height: cropSize })
  .resize(512, 512, { kernel: sharp.kernel.lanczos3, fit: "fill" })
  .ensureAlpha()
  .png()
  .toBuffer();

const icoPngBuffers = await Promise.all(
  ICON_SIZES.map((size) =>
    sharp(master512)
      .resize(size, size, {
        kernel: size <= 32 ? sharp.kernel.mitchell : sharp.kernel.lanczos3,
        fit: "fill",
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
  ),
);

const ico = await pngToIco(icoPngBuffers);
const icon256 = await sharp(master512).resize(256, 256).png().toBuffer();

await writeFile(iconPng, icon256);
await writeFile(join(buildDir, "icon-512.png"), master512);
await writeFile(iconIco, ico);
await writeFile(electronIconIco, ico);
await writeFile(appIconPng, master512);
await writeFile(faviconIco, ico);

console.log(
  `[prepare-desktop-icon] wrote PeakCAD icons (${ICON_SIZES.join("/")}px) → ${iconIco}, ${electronIconIco}, ${appIconPng}, ${faviconIco}`,
);
