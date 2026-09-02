// Generates build/icon.ico (multi-size) and build/icon.png (512) from the
// brand SVG, rendering through Chromium's canvas so there's no native image
// dependency. Run with: npm run icons
import { app, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const SRC = path.join(root, "src", "public", "logo.svg");
const OUT_ICO = path.join(root, "build", "icon.ico");
const OUT_PNG = path.join(root, "build", "icon.png");

// Sizes Windows actually picks between (taskbar, alt-tab, explorer, tooltips).
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// The mark is 1.79:1, so it can't fill a square. Small padding keeps it
// as large as possible without touching the edges.
const PADDING_RATIO = 0.04;

/** ICO container: 6-byte header, 16 bytes per entry, then the PNG payloads. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((img, i) => {
    const e = 16 * i;
    // 256 is encoded as 0 in a single byte.
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0);
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    entries.writeUInt8(0, e + 2); // palette count
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(img.buf.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.buf.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.buf)]);
}

/**
 * The mark sits in the middle of a 1024x572 canvas with a lot of empty space
 * around it, so fitting the whole viewBox into a square yields a tiny icon.
 * Find the real ink bounds by scanning alpha, then crop to them.
 */
async function measureInkBounds(win, svgDataUrl) {
  return win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(svgDataUrl)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { x: 0, y: 0, w: img.width, h: img.height, imgW: img.width, imgH: img.height };
    return {
      x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
      imgW: img.width, imgH: img.height
    };
  })()`);
}

async function renderPng(win, svgDataUrl, size, bounds) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(svgDataUrl)};
    await img.decode();
    const size = ${size};
    const b = ${JSON.stringify(bounds)};
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const pad = size * ${PADDING_RATIO};
    const avail = size - pad * 2;
    const scale = Math.min(avail / b.w, avail / b.h);
    const w = b.w * scale;
    const h = b.h * scale;
    // Draw only the inked region, centred in the square.
    ctx.drawImage(img, b.x, b.y, b.w, b.h, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

app.whenReady().then(async () => {
  const svg = await fs.readFile(SRC, "utf-8");
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;

  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(root, "src", "public", "logo.svg")).toString());
  // Any document will do; we only need a canvas context.
  await win.loadURL("data:text/html,<html><body></body></html>");

  const bounds = await measureInkBounds(win, svgDataUrl);
  console.log(
    `ink bounds: ${bounds.w}x${bounds.h} at (${bounds.x},${bounds.y}) within ${bounds.imgW}x${bounds.imgH}\n`
  );

  const images = [];
  for (const size of ICO_SIZES) {
    const buf = await renderPng(win, svgDataUrl, size, bounds);
    images.push({ size, buf });
    console.log(`  rendered ${size}x${size} (${buf.length} bytes)`);
  }

  await fs.mkdir(path.dirname(OUT_ICO), { recursive: true });
  const ico = buildIco(images);
  await fs.writeFile(OUT_ICO, ico);
  console.log(`\nwrote ${path.relative(root, OUT_ICO)} (${ico.length} bytes, ${images.length} sizes)`);

  const png512 = await renderPng(win, svgDataUrl, 512, bounds);
  await fs.writeFile(OUT_PNG, png512);
  console.log(`wrote ${path.relative(root, OUT_PNG)} (${png512.length} bytes)`);

  app.exit(0);
});
