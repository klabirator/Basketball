// Фоновый поток: поиск кольца по форме (сетка + щит), чтобы не тормозить видео.
import { RimLocator } from './rimfinder.js';

const locator = new RimLocator();
self.onmessage = (e) => {
  const { id, gray, w, h, colorCand } = e.data;
  let rim = null;
  try {
    rim = locator.locate(gray, w, h, colorCand);
  } catch {
    rim = null;
  }
  self.postMessage({ id, rim });
};
