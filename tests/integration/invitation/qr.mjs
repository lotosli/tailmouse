import { chromium } from '@playwright/test';

const chunks = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > 1_000_000)
    throw new Error('QR fixture input exceeded its bound');
  chunks.push(chunk);
}
const fixtures = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (fixtures.length !== 4)
  throw new Error('Expected four synthetic QR fixtures');
const browser = await chromium.launch({ timeout: 10_000 });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  // A routed secure loopback origin requires no network listener or real site.
  await page.route('http://127.0.0.1/qr', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>QR test</title>',
    }),
  );
  await page.goto('http://127.0.0.1/qr');
  await page.evaluate(async (cases) => {
    if (
      typeof BarcodeDetector === 'undefined' ||
      !(await BarcodeDetector.getSupportedFormats()).includes('qr_code')
    ) {
      throw new Error('Native QR detection is unavailable');
    }
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    for (const fixture of cases) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = fixture.bitmap.length * 4;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('QR canvas is unavailable');
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'black';
      fixture.bitmap.forEach((row, y) => {
        row.forEach((dark, x) => {
          if (dark) context.fillRect(x * 4, y * 4, 4, 4);
        });
      });
      const decoded = await detector.detect(canvas);
      if (decoded.length !== 1 || decoded[0].rawValue !== fixture.source) {
        throw new Error(
          'QR decoder did not recover the exact synthetic source',
        );
      }
    }
  }, fixtures);
  process.stdout.write('QR_DECODE_PASSED 4\n');
} finally {
  await browser.close();
}
