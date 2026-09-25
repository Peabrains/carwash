import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissTransientOverlays } from '../src/lib/transient-overlays.js';

test('route changes remove every open booking overlay', () => {
  const removed = [];
  const overlays = [
    { remove: () => removed.push('first') },
    { remove: () => removed.push('second') },
  ];
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, '[data-transient-overlay]');
      return overlays;
    },
  };

  dismissTransientOverlays(root);

  assert.deepEqual(removed, ['first', 'second']);
});
