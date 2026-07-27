import { describe, expect, it } from 'vitest';
import {
  buildPreviewFeedbackText,
  normalizePreviewElementContext,
  normalizePreviewSelector,
} from './preview-feedback.js';

describe('normalizePreviewElementContext', () => {
  it('bounds untrusted page data and keeps only the compact allowlist', () => {
    const context = normalizePreviewElementContext({
      tagName: ' DIV ',
      text: ` Coupon\n expired ${'x'.repeat(400)}`,
      accessibleName: ' Coupon status ',
      role: 'status',
      testId: 'coupon-hint',
      classes: ['coupon-hint', 'muted', 'wide', 'a', 'b', 'c', 'ignored'],
      componentHint: '<CheckoutPage> > <CouponHint>',
      sourceHint: 'src/checkout/CouponHint.tsx:42:7',
      styles: {
        display: 'block',
        position: 'static',
        padding: ' 0px ',
        fontSize: '14px',
        color: 'rgb(31, 41, 55)',
        cursor: 'pointer',
      },
      outerHTML: '<div>must not pass</div>',
    });

    expect(context).toMatchObject({
      tagName: 'div',
      accessibleName: 'Coupon status',
      role: 'status',
      testId: 'coupon-hint',
      classes: ['coupon-hint', 'muted', 'wide', 'a', 'b', 'c'],
      componentHint: '<CheckoutPage> > <CouponHint>',
      sourceHint: 'src/checkout/CouponHint.tsx:42:7',
      styles: {
        display: 'block',
        position: 'static',
        padding: '0px',
        fontSize: '14px',
        color: 'rgb(31, 41, 55)',
      },
    });
    expect(context?.text?.length).toBe(300);
    expect(context?.styles).not.toHaveProperty('cursor');
    expect(context).not.toHaveProperty('outerHTML');
  });

  it('fails closed without a usable element tag', () => {
    expect(normalizePreviewElementContext(null)).toBeNull();
    expect(normalizePreviewElementContext({ text: 'orphaned' })).toBeNull();
  });

  it('compacts the untrusted selector before it enters the prompt', () => {
    expect(normalizePreviewSelector('  #hint\nignore this  ')).toBe('#hint ignore this');
    expect(normalizePreviewSelector({ selector: '#hint' })).toBeNull();
  });
});

describe('buildPreviewFeedbackText', () => {
  it('adds semantic locator data and filters low-signal rendered styles', () => {
    const context = normalizePreviewElementContext({
      tagName: 'div',
      text: 'Coupon expired',
      accessibleName: 'Coupon status',
      role: 'status',
      classes: ['coupon-hint'],
      componentHint: '<CheckoutPage> > <CouponHint>',
      sourceHint: 'src/checkout/CouponHint.tsx:42:7',
      styles: {
        display: 'block',
        position: 'static',
        padding: '0px',
        fontSize: '14px',
        color: 'rgb(31, 41, 55)',
      },
    });
    expect(context).not.toBeNull();

    const text = buildPreviewFeedbackText(
      {
        pageUrl: 'http://localhost:5173/checkout',
        rect: { x: 10, y: 20, width: 180, height: 24 },
        selector: '#hint',
        elementContext: context,
      },
      'Keep this on one line.',
    );

    expect(text).toContain('Element: `#hint` at x=10, y=20, width=180, height=24');
    expect(text).toContain('untrusted page data');
    expect(text).toContain('<div> role="status" accessible-name="Coupon status"');
    expect(text).toContain('Visible text: "Coupon expired"');
    expect(text).toContain('Framework component hint (best effort)');
    expect(text).toContain('Source hint (best effort): `src/checkout/CouponHint.tsx:42:7`');
    expect(text).toContain('display: block');
    expect(text).toContain('font-size: 14px');
    expect(text).not.toContain('position: static');
    expect(text).not.toContain('padding: 0px');
    expect(text).toContain('- Note: Keep this on one line.');
  });

  it('keeps drawn-region feedback compact and DOM-free', () => {
    const text = buildPreviewFeedbackText(
      {
        pageUrl: 'http://localhost:5173/',
        rect: { x: 1, y: 2, width: 30, height: 40 },
        selector: null,
        elementContext: null,
      },
      'Align this area.',
    );
    expect(text).toContain('Selected region: x=1, y=2, width=30, height=40');
    expect(text).not.toContain('Rendered element context');
  });
});
