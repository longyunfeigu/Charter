import { describe, expect, it } from 'vitest';
import { PreviewAttachmentSchema, PreviewElementContextSchema } from './agent-dto.js';

const context = {
  tagName: 'button',
  text: 'Pay now',
  accessibleName: 'Submit payment',
  role: 'button',
  testId: 'pay',
  classes: ['primary', 'compact'],
  componentHint: '<CheckoutPage> > <PayButton>',
  sourceHint: 'src/PayButton.tsx:18:3',
  styles: { display: 'inline-flex', fontSize: '14px', padding: '8px 12px' },
};

describe('PreviewElementContextSchema', () => {
  it('accepts the compact Context+ payload', () => {
    expect(PreviewElementContextSchema.safeParse(context).success).toBe(true);
    expect(
      PreviewAttachmentSchema.safeParse({
        dataBase64: 'iVBORw0K',
        mimeType: 'image/png',
        pageUrl: 'http://localhost:5173/',
        rect: { x: 1, y: 2, width: 100, height: 40 },
        selector: '#pay',
        elementContext: context,
      }).success,
    ).toBe(true);
  });

  it('rejects broad DOM dumps, unknown styles, and oversized values', () => {
    expect(
      PreviewElementContextSchema.safeParse({ ...context, outerHTML: '<button>Pay</button>' })
        .success,
    ).toBe(false);
    expect(
      PreviewElementContextSchema.safeParse({
        ...context,
        styles: { ...context.styles, cursor: 'pointer' },
      }).success,
    ).toBe(false);
    expect(
      PreviewElementContextSchema.safeParse({ ...context, text: 'x'.repeat(301) }).success,
    ).toBe(false);
  });
});
