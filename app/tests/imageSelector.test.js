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

  const nextCycle = selectIds(2, 22, 25);
  assert.equal(new Set(nextCycle).size, 25);
  assert.notDeepEqual(nextCycle, cumulativeCycle);
  for (let index = 2; index < nextCycle.length; index += 1) {
    const batch = nextCycle[index].split('_')[0];
    assert.ok(!(batch === nextCycle[index - 1].split('_')[0] &&
      batch === nextCycle[index - 2].split('_')[0]));
  }
});

test('batch introductions use a constrained deterministic shuffle', () => {
  const batch = Array.from({ length: 5 }, (_, index) =>
    image(`jan5_${index}`, '2025-01-05T00:00:00Z')
  );
  const images = Array.from({ length: 10 }, (_, index) =>
    image(`jan1_${index}`, '2025-01-01T00:00:00Z')
  ).concat(batch);
  const introduction = Array.from({ length: 5 }, (_, index) =>
    selectImageForDate(images, `2025-01-${String(11 + index).padStart(2, '0')}`)
  );

  assert.deepEqual(introduction.map(({ id }) => id), [
    'jan5_1', 'jan5_4', 'jan5_2', 'jan5_3', 'jan5_0'
  ]);
  assert.deepEqual(
    introduction.map(({ id }) => id),
    Array.from({ length: 5 }, (_, index) =>
      selectImageForDate([...images].reverse(), `2025-01-${String(11 + index).padStart(2, '0')}`).id
    )
  );

  const sourceRanks = new Map(batch.map(({ id }, index) => [id, index]));
  for (let index = 2; index < introduction.length; index += 1) {
    const first = sourceRanks.get(introduction[index - 2].id);
    const second = sourceRanks.get(introduction[index - 1].id);
    const third = sourceRanks.get(introduction[index].id);
    assert.notDeepEqual([second - first, third - second], [1, 1]);
    assert.notDeepEqual([second - first, third - second], [-1, -1]);
  }
});

test('single-batch cumulative cycles retain the source-order run constraint', () => {
  const images = Array.from({ length: 5 }, (_, index) =>
    image(`single_${index}`, '2025-01-01T00:00:00Z')
  );
  const sourceRanks = new Map(images.map(({ id }, index) => [id, index]));
  const getCycle = (startDay) => Array.from({ length: 5 }, (_, offset) =>
    selectImageForDate(images, new Date(Date.UTC(2025, 0, startDay + offset)).toISOString()).id
  );
  const firstCycle = getCycle(6);
  const secondCycle = getCycle(11);

  for (const cycle of [firstCycle, secondCycle]) {
    assert.equal(new Set(cycle).size, 5);
    for (let index = 2; index < cycle.length; index += 1) {
      const first = sourceRanks.get(cycle[index - 2]);
      const second = sourceRanks.get(cycle[index - 1]);
      const third = sourceRanks.get(cycle[index]);
      assert.notDeepEqual([second - first, third - second], [1, 1]);
      assert.notDeepEqual([second - first, third - second], [-1, -1]);
    }
  }
  assert.notDeepEqual(firstCycle, secondCycle);
});

test('cumulative cycles mix batches with no run longer than two when feasible', () => {
  const batch1 = Array.from({ length: 10 }, (_, index) =>
    image(`jan1_${index}`, '2025-01-01T00:00:00Z')
  );
  const batch2 = Array.from({ length: 5 }, (_, index) =>
    image(`jan5_${index}`, '2025-01-05T00:00:00Z')
  );
  const batch3 = Array.from({ length: 10 }, (_, index) =>
    image(`feb2_${index}`, '2025-02-02T00:00:00Z')
  );
  const images = [...batch1, ...batch2, ...batch3];
  const selected = Array.from({ length: 25 }, (_, offset) =>
    selectImageForDate(images, new Date(Date.UTC(2025, 1, 25 + offset)).toISOString())
  );
  const selectedIds = selected.map(({ id }) => id);
  const batches = selected.map(({ id }) => id.split('_')[0]);

  assert.equal(new Set(selectedIds).size, 25);
  for (let index = 2; index < batches.length; index += 1) {
    assert.ok(!(batches[index] === batches[index - 1] && batches[index] === batches[index - 2]));
  }
  assert.deepEqual(
    selectedIds,
    Array.from({ length: 25 }, (_, offset) =>
      selectImageForDate(images, new Date(Date.UTC(2025, 1, 25 + offset)).toISOString()).id
    )
  );
});

test('cumulative run limit relaxes only as much as a dominant batch requires', () => {
  const batch1 = Array.from({ length: 5 }, (_, index) =>
    image(`large_${index}`, '2025-01-01T00:00:00Z')
  );
  const batch2 = [image('small_0', '2025-01-02T00:00:00Z')];
  const images = [...batch1, ...batch2];
  const cycle = Array.from({ length: 6 }, (_, offset) =>
    selectImageForDate(images, new Date(Date.UTC(2025, 0, 7 + offset)).toISOString())
  );
  const ids = cycle.map(({ id }) => id);
  const batches = cycle.map(({ id }) => id.split('_')[0]);

  assert.equal(new Set(ids).size, 6);
  let longestRun = 1;
  let currentRun = 1;
  for (let index = 1; index < batches.length; index += 1) {
    currentRun = batches[index] === batches[index - 1] ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }
  assert.equal(longestRun, 3);
});