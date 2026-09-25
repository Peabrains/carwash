import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthRedirectStarted } from '../src/lib/auth-flow.js';

test('OAuth URL means the browser redirect has started', () => {
  assert.equal(oauthRedirectStarted({ provider: 'google', url: 'https://accounts.google.com/o/oauth2/auth' }), true);
});

test('missing OAuth URL does not count as a started redirect', () => {
  assert.equal(oauthRedirectStarted({ provider: 'google', url: '' }), false);
  assert.equal(oauthRedirectStarted(null), false);
});
