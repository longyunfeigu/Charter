// Smoke test for the four capture-direction mocks: load, interact, screenshot.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, '.shots');
const url = (f) => 'file://' + path.join(dir, f);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

async function check(name, fn) {
  const before = errors.length;
  try {
    await fn();
    const delta = errors.slice(before);
    console.log(delta.length ? `✗ ${name}\n  ${delta.join('\n  ')}` : `✓ ${name}`);
  } catch (e) {
    console.log(`✗ ${name} — ${e.message.split('\n')[0]}`);
  }
}

// index
await check('index loads', async () => {
  await page.goto(url('index.html'));
  await page.waitForSelector('.dir-card:nth-child(4)');
  await page.screenshot({ path: path.join(shots, 'index.png'), fullPage: true });
});

// A
await check('A: palette opens, sample parses, card structures, drawer opens', async () => {
  await page.goto(url('a-capture-ai.html'));
  await page.click('#btnNew');
  await page.waitForSelector('.cap-palette');
  await page.click('[data-sample="slack"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.work-card.is-structuring');
  await page.waitForSelector('.ai-review-btn', { timeout: 6000 });
  await page.screenshot({ path: path.join(shots, 'a-card.png') });
  await page.click('.ai-review-btn');
  await page.waitForSelector('.drawer');
  await page.click('#rvPriority');
  await page.waitForSelector('.pop-item');
  await page.click('.pop-item:nth-child(6)'); // Urgent (head + 5 items)
  await page.screenshot({ path: path.join(shots, 'a-drawer.png') });
  await page.click('#rvOk');
});

// B
await check('B: modal, chips popovers, create lands card', async () => {
  await page.goto(url('b-progressive-modal.html'));
  await page.click('#btnNew');
  await page.fill('#pmTitle', 'Answer the enterprise security questionnaire');
  await page.click('[data-k="priority"]');
  await page.waitForSelector('.pop-item');
  await page.click('.pop:has-text("PRIORITY") .pop-item:nth-child(5)');
  await page.click('[data-k="due"]');
  await page.waitForSelector('.pop-item');
  await page.click('.pop .pop-item:nth-child(4)');
  await page.click('[data-k="more"]');
  await page.waitForSelector('#pmMore:not(.hidden)');
  await page.screenshot({ path: path.join(shots, 'b-modal.png') });
  await page.click('#pmSubmit');
  await page.waitForSelector('.work-card.landing');
});

// C
await check('C: composer tokens, enter adds, cmd-enter opens drawer, due popover', async () => {
  await page.goto(url('c-inline-add.html'));
  await page.keyboard.press('n');
  await page.waitForSelector('.qa-composer textarea');
  await page.fill('.qa-composer textarea', '');
  await page.type('.qa-composer textarea', 'Follow up with Maya on pricing copy !high @aug 20 #launch', { delay: 2 });
  await page.waitForSelector('.qa-parsed:not(.hidden)');
  await page.screenshot({ path: path.join(shots, 'c-composer.png') });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.work-card.landing');
  await page.type('.qa-composer textarea', 'Draft the SOC 2 renewal plan', { delay: 2 });
  await page.keyboard.press('Meta+Enter');
  await page.waitForSelector('.drawer');
  await page.click('.prop-row:nth-child(4) .prop-value'); // Due
  await page.waitForSelector('.pop-item');
  await page.click('.pop .pop-item:nth-child(4)');
  await page.screenshot({ path: path.join(shots, 'c-drawer.png') });
  await page.click('#cdDone');
});

// D
await check('D: doc page, title, priority+due popovers, back lands card', async () => {
  await page.goto(url('d-document-page.html'));
  await page.click('#btnNew');
  await page.waitForSelector('.doc-view');
  await page.type('#docTitle', 'Renew the SOC 2 evidence pack', { delay: 2 });
  await page.click('.doc-props .prop-row:nth-child(3) .prop-value');
  await page.waitForSelector('.pop-item');
  await page.click('.pop .pop-item:nth-child(5)'); // High
  await page.click('.doc-props .prop-row:nth-child(4) .prop-value');
  await page.waitForSelector('.pop-item');
  await page.click('.pop .pop-item:nth-child(4)');
  await page.click('#docAcc .check-add');
  await page.type('#docAcc .cl-text', 'Auditor confirms the pack is complete', { delay: 2 });
  await page.screenshot({ path: path.join(shots, 'd-page.png') });
  await page.click('#docBack');
  await page.waitForSelector('.work-card.landing');
  await page.screenshot({ path: path.join(shots, 'd-board.png') });
});

await browser.close();
console.log(errors.length ? `\nTOTAL ERRORS: ${errors.length}` : '\nAll pages clean — no console/page errors.');
