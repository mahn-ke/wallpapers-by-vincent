import { seededHash } from './seededRandom.js';

const INTRO_SHUFFLE_SEED_VERSION = 76;

export function getAvailableImages(allImages, requestDate) {
  const cutoffDate = new Date(requestDate);

  return allImages
    .filter((image) => new Date(image.fileCreatedAt) <= cutoffDate)
    .sort((first, second) => {
      const dateDifference = new Date(first.fileCreatedAt) - new Date(second.fileCreatedAt);
      return dateDifference || first.id.localeCompare(second.id);
    });
}

function dateString(date) {
  return new Date(date).toISOString().split('T')[0];
}

function daysBetween(startDate, endDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((Date.parse(endDate) - Date.parse(startDate)) / millisecondsPerDay);
}

function orderBySeed(items, seed, getKey = (item) => item.id) {
  return [...items].sort((first, second) => {
    const firstKey = getKey(first);
    const secondKey = getKey(second);
    return seededHash(`${seed}:${firstKey}`).localeCompare(seededHash(`${seed}:${secondKey}`)) ||
      String(firstKey).localeCompare(String(secondKey));
  });
}

function hasSourceOrderRun(images, sourceRanks) {
  for (let index = 2; index < images.length; index += 1) {
    const first = sourceRanks.get(images[index - 2].id);
    const second = sourceRanks.get(images[index - 1].id);
    const third = sourceRanks.get(images[index].id);
    if ((second === first + 1 && third === second + 1) ||
        (second === first - 1 && third === second - 1)) {
      return true;
    }
  }
  return false;
}

function shuffleIntroduction(images, seed) {
  const sourceOrder = [...images].sort((first, second) => first.id.localeCompare(second.id));
  if (sourceOrder.length < 3) {
    return orderBySeed(sourceOrder, `${seed}:${INTRO_SHUFFLE_SEED_VERSION}`);
  }

  const sourceRanks = new Map(sourceOrder.map((image, index) => [image.id, index]));
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const version = INTRO_SHUFFLE_SEED_VERSION + attempt;
    const shuffled = orderBySeed(sourceOrder, `${seed}:${version}`);
    if (!hasSourceOrderRun(shuffled, sourceRanks)) {
      return shuffled;
    }
  }

  return [...sourceOrder.filter((_, index) => index % 2 === 0),
    ...sourceOrder.filter((_, index) => index % 2 === 1)];
}

function canCompleteGroupOrder(remaining, nextGroup, nextRunLength, maxRunLength) {
  const remainingTotal = [...remaining.values()].reduce((total, count) => total + count, 0);

  for (const [group, count] of remaining) {
    if (count === 0) continue;
    const otherCount = remainingTotal - count;
    const capacity = group === nextGroup
      ? (maxRunLength * otherCount) + (maxRunLength - nextRunLength)
      : maxRunLength * (otherCount + 1);
    if (count > capacity) return false;
  }
  return true;
}

function shuffleCumulative(batches, seed) {
  const shuffledByBatch = new Map(batches.map((batch) => [
    batch.createdDate,
    shuffleIntroduction(batch.images, `${seed}:images:${batch.createdDate}`)
  ]));
  const remaining = new Map(batches.map((batch) => [batch.createdDate, batch.images.length]));
  const totalImages = [...remaining.values()].reduce((total, count) => total + count, 0);
  const largestBatch = Math.max(...remaining.values());
  // A dominant batch may make a two-image run limit mathematically impossible.
  const maxRunLength = Math.max(2, Math.ceil(largestBatch / (totalImages - largestBatch + 1)));
  const nextImageIndex = new Map(batches.map((batch) => [batch.createdDate, 0]));
  const result = [];
  let previousGroup = null;
  let previousRunLength = 0;

  while (result.length < totalImages) {
    const candidates = [...remaining.keys()]
      .filter((group) => remaining.get(group) > 0 &&
        (group !== previousGroup || previousRunLength < maxRunLength))
      .sort((first, second) =>
        seededHash(`${seed}:groups:${result.length}:${first}`).localeCompare(
          seededHash(`${seed}:groups:${result.length}:${second}`)
        ) || first.localeCompare(second));

    let selectedGroup;
    let selectedRunLength;
    for (const group of candidates) {
      const runLength = group === previousGroup ? previousRunLength + 1 : 1;
      const afterSelection = new Map(remaining);
      afterSelection.set(group, afterSelection.get(group) - 1);
      if (canCompleteGroupOrder(afterSelection, group, runLength, maxRunLength)) {
        selectedGroup = group;
        selectedRunLength = runLength;
        break;
      }
    }

    if (selectedGroup === undefined) {
      throw new Error('Unable to construct a valid cumulative image order');
    }

    const imageIndex = nextImageIndex.get(selectedGroup);
    result.push(shuffledByBatch.get(selectedGroup)[imageIndex]);
    nextImageIndex.set(selectedGroup, imageIndex + 1);
    remaining.set(selectedGroup, remaining.get(selectedGroup) - 1);
    previousRunLength = selectedRunLength;
    previousGroup = selectedGroup;
  }

  return result;
}

function getBatches(images) {
  const batchesByDate = new Map();

  for (const image of images) {
    const createdDate = dateString(image.fileCreatedAt);
    const batch = batchesByDate.get(createdDate) || [];
    batch.push(image);
    batchesByDate.set(createdDate, batch);
  }

  const batches = [...batchesByDate.entries()]
    .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate))
    .map(([createdDate, batch]) => ({
      createdDate,
      images: shuffleIntroduction(batch, createdDate),
      sourceImages: batch.sort((first, second) => first.id.localeCompare(second.id))
    }));

  const schedule = [];
  const cumulativeBatches = [];
  let cumulativeImageCount = 0;
  let cycleStartDate = null;

  for (const batch of batches) {
    if (!cycleStartDate) {
      cycleStartDate = batch.createdDate;
    } else {
      const elapsedDays = daysBetween(cycleStartDate, batch.createdDate);
      const completedCycles = Math.ceil(elapsedDays / cumulativeImageCount);
      cycleStartDate = new Date(
        Date.parse(cycleStartDate) + (completedCycles * cumulativeImageCount * 24 * 60 * 60 * 1000)
      ).toISOString().split('T')[0];
    }

    schedule.push({ startDate: cycleStartDate, type: 'introduction', images: batch.images });
    cycleStartDate = new Date(
      Date.parse(cycleStartDate) + (batch.images.length * 24 * 60 * 60 * 1000)
    ).toISOString().split('T')[0];
    cumulativeBatches.push({ createdDate: batch.createdDate, images: batch.sourceImages });
    cumulativeImageCount += batch.sourceImages.length;
    schedule.push({
      startDate: cycleStartDate,
      type: 'cumulative',
      batches: [...cumulativeBatches],
      imageCount: cumulativeImageCount
    });
  }

  return schedule;
}

export function selectImageForDate(allImages, requestDate) {
  const availableImages = getAvailableImages(allImages, requestDate);
  if (availableImages.length === 0) return null;

  const requestedDate = dateString(requestDate);
  const batches = getBatches(availableImages);
  const activePhase = batches.findLast((batch) => batch.startDate <= requestedDate);
  const dayOffset = daysBetween(activePhase.startDate, requestedDate);
  if (activePhase.type === 'introduction') {
    return activePhase.images[dayOffset % activePhase.images.length];
  }

  const cycleIndex = Math.floor(dayOffset / activePhase.imageCount);
  const cycleOffset = dayOffset % activePhase.imageCount;
  const cycleImages = shuffleCumulative(
    activePhase.batches,
    `${activePhase.startDate}:${cycleIndex}`
  );
  return cycleImages[cycleOffset];
}