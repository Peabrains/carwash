import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleLabel } from '../src/lib/appointment-display.js';

test('vehicle label includes plate and make/model', () => {
  assert.equal(vehicleLabel({ vehicle_plate: 'ABC 123', vehicle_make_model: 'Perodua Myvi' }), 'ABC 123 · Perodua Myvi');
});

test('vehicle label handles missing vehicle values', () => {
  assert.equal(vehicleLabel({ vehicle_plate: '', vehicle_make_model: '' }), '—');
});
