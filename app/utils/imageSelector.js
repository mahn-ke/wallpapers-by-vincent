import { seededRandom } from './seededRandom.js';

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

function shuffleImages(images, seed) {
  const shuffled = [...images];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = seededRandom(`${seed}:${index}`, index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
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
      images: shuffleImages(
        batch.sort((first, second) => first.id.localeCompare(second.id)),
        createdDate
      )
    }));

  const schedule = [];
  let cumulativeImages = [];
  let cycleStartDate = null;

  for (const batch of batches) {
    if (!cycleStartDate) {
      cycleStartDate = batch.createdDate;
    } else {
      const elapsedDays = daysBetween(cycleStartDate, batch.createdDate);
      const completedCycles = Math.ceil(elapsedDays / cumulativeImages.length);
      cycleStartDate = new Date(
        Date.parse(cycleStartDate) + (completedCycles * cumulativeImages.length * 24 * 60 * 60 * 1000)
      ).toISOString().split('T')[0];
    }

    schedule.push({ startDate: cycleStartDate, images: batch.images });
    cycleStartDate = new Date(
      Date.parse(cycleStartDate) + (batch.images.length * 24 * 60 * 60 * 1000)
    ).toISOString().split('T')[0];
    cumulativeImages = [...cumulativeImages, ...batch.images];
    schedule.push({ startDate: cycleStartDate, images: cumulativeImages });
  }

  return schedule;
}

export function selectImageForDate(allImages, requestDate) {
  const availableImages = getAvailableImages(allImages, requestDate);
  if (availableImages.length === 0) return null;

  const requestedDate = dateString(requestDate);
  const batches = getBatches(availableImages);
  const activeBatch = batches.findLast((batch) => batch.startDate <= requestedDate);
  const dayOffset = daysBetween(activeBatch.startDate, requestedDate);
  return activeBatch.images[dayOffset % activeBatch.images.length];
}