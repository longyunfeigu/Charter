import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto('file://' + path.join(dir, 'index.html'));
await page.waitForSelector('.ra-stack-a .ra-card');
await page.waitForTimeout(900); // settle pop, heartbeat armed
await page.screenshot({ path: path.join(dir, '.shot-a.png') });

await page.click('[data-v="b"]');
await page.waitForTimeout(500); // mid-swing
await page.screenshot({ path: path.join(dir, '.shot-b-swing.png') });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(dir, '.shot-b.png') });

await page.click('[data-v="c"]');
await page.waitForTimeout(700); // center takeover visible
await page.screenshot({ path: path.join(dir, '.shot-c-center.png') });
await page.waitForTimeout(1600); // docked to pill
await page.screenshot({ path: path.join(dir, '.shot-c-pill.png') });

await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'clean');
