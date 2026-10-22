import { describe, expect, it } from 'vitest';
import {
  assertProductHasSubmissionImages,
  statusAfterSupplierEdit,
  toPublicProduct,
} from '../src/services/products.service.js';

describe('product moderation and public catalogue', () => {
  it('hides supplier name and id on Copeland-label products', () => {
    const result = toPublicProduct({
      id: 'product-1',
      partnerId: 'supplier-private-id',
      isCopelandLabel: true,
      name: 'Copeland item',
    }, 'Private Supplier Ltd');

    expect(result).toEqual({
      id: 'product-1',
      isCopelandLabel: true,
      name: 'Copeland item',
      supplier: null,
    });
    expect(JSON.stringify(result)).not.toContain('supplier-private-id');
    expect(JSON.stringify(result)).not.toContain('Private Supplier Ltd');
  });

  it('requires three images before review submission', () => {
    expect(() => assertProductHasSubmissionImages(['front.jpg', 'back.jpg']))
      .toThrow('At least three product images');
    expect(() => assertProductHasSubmissionImages(['front.jpg', 'back.jpg', 'detail.jpg']))
      .not.toThrow();
  });

  it('sends edits to approved or paused products back for review', () => {
    expect(statusAfterSupplierEdit('approved')).toBe('submitted');
    expect(statusAfterSupplierEdit('paused')).toBe('submitted');
    expect(statusAfterSupplierEdit('draft')).toBe('draft');
  });
});
