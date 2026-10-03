import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableImages, selectImageForDate } from '../utils/imageSelector.js';

function image(id, fileCreatedAt) {
  return { id, fileCreatedAt };
}

test('selection is deterministic for the same date', () => {
  const images = [
    image('first', '2025-01-01T00:00:00Z'),
    image('second', '2025-01-02T00:00:00Z'),
    image('third', '2025-01-03T00:00:00Z')
  ];

  assert.equal(
    selectImageForDate(images, '2025-01-04T00:00:00Z')?.id,
    selectImageForDate(images, '2025-01-04T12:00:00Z')?.id
  );
});

test('assets are ordered and filtered by creation date', () => {
  const images = [
    image('later', '2025-01-03T00:00:00Z'),
    image('first', '2025-01-01T00:00:00Z'),
    image('second', '2025-01-02T00:00:00Z')
  ];

  assert.deepEqual(
    getAvailableImages(images, '2025-01-02T00:00:00Z').map(({ id }) => id),
    ['first', 'second']
  );
});

test('adding later assets does not reshuffle earlier dates', () => {
  const originalImages = [
    image('first', '2025-01-01T00:00:00Z'),
    image('second', '2025-01-02T00:00:00Z')
  ];
  const expandedImages = [
    ...originalImages,
    image('third', '2025-01-03T00:00:00Z')
  ];

  assert.equal(
    selectImageForDate(expandedImages, '2025-01-02T00:00:00Z')?.id,
    selectImageForDate(originalImages, '2025-01-02T00:00:00Z')?.id
  );
  assert.equal(
    getAvailableImages(expandedImages, '2025-01-02T00:00:00Z').some(({ id }) => id === 'third'),
    false
  );
});

test('staged ten-image batches remain stable across date gaps', () => {
  const batch1 = Array.from({ length: 10 }, (_, index) =>
    image(`batch1_${index}`, '2024-12-31T10:00:00Z')
  );
  const batch2 = Array.from({ length: 10 }, (_, index) =>
    image(`batch2_${index}`, '2025-01-15T00:00:00Z')
  );
  const batch3 = Array.from({ length: 10 }, (_, index) =>
    image(`batch3_${index}`, '2025-01-30T00:00:00Z')
  );

  const firstPeriod = ['2025-01-01', '2025-01-07'];
  const secondPeriod = ['2025-01-15', '2025-01-21'];
  const thirdPeriod = ['2025-01-30', '2025-02-05'];
  const selectPeriod = (images, dates) => dates.map((date) => selectImageForDate(images, date)?.id);

  assert.deepEqual(
    selectPeriod(batch1, firstPeriod),
    selectPeriod([...batch1, ...batch2, ...batch3], firstPeriod)
  );

  assert.deepEqual(
    getAvailableImages([...batch1, ...batch2, ...batch3], secondPeriod[0]).length,
    20
  );
  assert.deepEqual(
    getAvailableImages([...batch1, ...batch2, ...batch3], thirdPeriod[0]).length,
    30
  );

  for (const date of [...secondPeriod, ...thirdPeriod]) {
    const selected = selectImageForDate([...batch1, ...batch2, ...batch3], date);
    assert.ok(selected?.id.startsWith('batch'));
    assert.ok(new Date(selected.fileCreatedAt) <= new Date(date));
  }
});

test('new batches are introduced once before joining the cumulative cycle', () => {
  const jan1Batch = Array.from({ length: 10 }, (_, index) =>
    image(`jan1_${index}`, '2025-01-01T00:00:00Z')
  );
  const jan5Batch = Array.from({ length: 5 }, (_, index) =>
    image(`jan5_${index}`, '2025-01-05T00:00:00Z')
  );
  const feb2Batch = Array.from({ length: 10 }, (_, index) =>
    image(`feb2_${index}`, '2025-02-02T00:00:00Z')
  );
  const allImages = [...jan1Batch, ...jan5Batch, ...feb2Batch];

  const selectIds = (month, startDay, count) => Array.from({ length: count }, (_, offset) =>
    selectImageForDate(
      allImages,
      new Date(Date.UTC(2025, month, startDay + offset)).toISOString()
    )?.id
  );

  assert.ok(selectIds(0, 1, 10).every((id) => id.startsWith('jan1_')));
  assert.ok(selectIds(0, 11, 5).every((id) => id.startsWith('jan5_')));
  assert.ok(selectIds(0, 16, 17).some((id) => id.startsWith('jan1_')));
  assert.ok(selectIds(0, 16, 17).some((id) => id.startsWith('jan5_')));
  assert.ok(selectIds(1, 2, 13).every((id) => id.startsWith('jan1_') || id.startsWith('jan5_')));

  assert.ok(selectIds(1, 15, 10).every((id) => id.startsWith('feb2_')));
  const cumulativeCycle = selectIds(1, 25, 25);
  assert.equal(new Set(cumulativeCycle).size, 25);
  assert.ok(cumulativeCycle.some((id) => id.startsWith('jan1_')));
  assert.ok(cumulativeCycle.some((id) => id.startsWith('jan5_')));
  assert.ok(cumulativeCycle.some((id) => id.startsWith('feb2_')));
});