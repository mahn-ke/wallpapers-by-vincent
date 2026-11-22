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

function getActivePhase(allImages, requestDate) {
  const availableImages = getAvailableImages(allImages, requestDate);
  if (availableImages.length === 0) return null;

  const requestedDate = dateString(requestDate);
  const activePhase = getBatches(availableImages).findLast((batch) => batch.startDate <= requestedDate);
  return { activePhase, requestedDate };
}

export function selectImageForDate(allImages, requestDate) {
  const phase = getActivePhase(allImages, requestDate);
  if (!phase) return null;

  const { activePhase, requestedDate } = phase;
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

// --- Workday-only mode (opt-in, see README) ---------------------------------
// Weekends show Friday's image. Weekend images assigned between `catchUpFrom`
// and `since` (which nobody saw) are replayed first, one per workday. After
// that the schedule resumes where it stood on `since` and advances only on
// workdays ("virtual date") until it reaches a cumulative full-shuffle phase;
// from then on the real date is used again.
// TODO: Once the switch back to the real date has happened, remove the
// catch-up queue and the virtual timeline and keep only the weekend → Friday
// mapping.

const DAY_MS = 24 * 60 * 60 * 1000;
const END_OF_DAY_MS = DAY_MS - 1;
const workdayCaches = new Map();

function dayStartMs(value) {
  return Date.parse(dateString(value));
}

function msToDateString(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

function isWeekend(dayMs) {
  const weekday = new Date(dayMs).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function previousFridayMs(dayMs) {
  const weekday = new Date(dayMs).getUTCDay();
  return dayMs - ((weekday + 2) % 7) * DAY_MS;
}

// Number of Mon–Fri days in [startMs, endMs).
function countWorkdays(startMs, endMs) {
  if (endMs <= startMs) return 0;
  const days = Math.round((endMs - startMs) / DAY_MS);
  let count = Math.floor(days / 7) * 5;
  for (let index = Math.floor(days / 7) * 7; index < days; index += 1) {
    if (!isWeekend(startMs + index * DAY_MS)) count += 1;
  }
  return count;
}

function imagesSignature(images) {
  return images
    .map((image) => `${image.id}@${image.fileCreatedAt}`)
    .sort()
    .join('|');
}

function getWorkdayCache(allImages, sinceMs, catchUpFromMs) {
  const key = `${sinceMs}:${catchUpFromMs}:${imagesSignature(allImages)}`;
  let cache = workdayCaches.get(key);
  if (cache) return cache;

  const queue = [];
  for (let dayMs = catchUpFromMs; dayMs < sinceMs; dayMs += DAY_MS) {
    if (!isWeekend(dayMs)) continue;
    const selected = selectImageForDate(allImages, msToDateString(dayMs));
    if (selected) queue.push(selected);
  }
  const catchUpLength = queue.length;

  const toVirtualMs = (instantMs) => {
    const createdDayMs = dayStartMs(instantMs);
    if (createdDayMs < sinceMs) return instantMs;

    let baseDayMs = createdDayMs;
    let timeOfDayMs = instantMs - createdDayMs;
    if (isWeekend(createdDayMs)) {
      baseDayMs = previousFridayMs(createdDayMs);
      timeOfDayMs = END_OF_DAY_MS;
      if (baseDayMs < sinceMs) return baseDayMs + timeOfDayMs;
    }

    const workdayIndex = countWorkdays(sinceMs, baseDayMs);
    if (workdayIndex < catchUpLength) return sinceMs - DAY_MS + END_OF_DAY_MS;
    return sinceMs + (workdayIndex - catchUpLength) * DAY_MS + timeOfDayMs;
  };

  const virtualImages = allImages.map((image) => ({
    ...image,
    fileCreatedAt: new Date(toVirtualMs(Date.parse(image.fileCreatedAt))).toISOString()
  }));

  cache = { queue, catchUpLength, virtualImages, switchIndex: null, checkedUntil: catchUpLength };
  workdayCaches.clear();
  workdayCaches.set(key, cache);
  return cache;
}

function virtualDateForIndex(sinceMs, cache, workdayIndex) {
  return msToDateString(sinceMs + (workdayIndex - cache.catchUpLength) * DAY_MS);
}

// First workday index after the catch-up at which the virtual schedule is in a
// cumulative phase. Each check only sees images available on that day, so later
// uploads cannot move an already reached switch point.
function hasSwitchedToRealDate(sinceMs, cache, workdayIndex) {
  if (cache.switchIndex !== null) return workdayIndex >= cache.switchIndex;

  for (let index = cache.checkedUntil; index <= workdayIndex; index += 1) {
    const phase = getActivePhase(cache.virtualImages, virtualDateForIndex(sinceMs, cache, index));
    if (phase?.activePhase.type === 'cumulative') {
      cache.switchIndex = index;
      return true;
    }
    cache.checkedUntil = index + 1;
  }
  return false;
}

export function selectWorkdayImageForDate(allImages, requestDate, { since, catchUpFrom = since }) {
  const sinceMs = Date.parse(since);
  const catchUpFromMs = Date.parse(catchUpFrom);
  let requestedDayMs = dayStartMs(requestDate);

  if (requestedDayMs < sinceMs) return selectImageForDate(allImages, msToDateString(requestedDayMs));
  if (isWeekend(requestedDayMs)) requestedDayMs = previousFridayMs(requestedDayMs);
  if (requestedDayMs < sinceMs) return selectImageForDate(allImages, msToDateString(requestedDayMs));

  const cache = getWorkdayCache(allImages, sinceMs, catchUpFromMs);
  const workdayIndex = countWorkdays(sinceMs, requestedDayMs);
  if (workdayIndex < cache.catchUpLength) return cache.queue[workdayIndex];

  if (hasSwitchedToRealDate(sinceMs, cache, workdayIndex)) {
    return selectImageForDate(allImages, msToDateString(requestedDayMs));
  }

  const selected = selectImageForDate(
    cache.virtualImages,
    virtualDateForIndex(sinceMs, cache, workdayIndex)
  );
  return selected && allImages.find((image) => image.id === selected.id);
}
