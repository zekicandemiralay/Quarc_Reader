// The scroll bar of the desktop reader: a thumb on a track at the right edge, like a normal PDF reader's, to go through a long
// document with the mouse. Pure maths (what the bar shows, and where a drag leads); the element itself lives in ReaderCanvas.
//
//   progress  0..1: how far through the document the view is (0 = the top of the first page, 1 = the bottom of the last)
//   visible   0..1: how much of the document is on screen (the thumb's size relative to the track)
//   track     the bar's height in px; the thumb is { h, top } inside it

import { INSETS } from './geometry.js';

export const MIN_THUMB = 36; // px: a thumb never gets smaller than that, however long the document

// Scroll mode (the pages stacked). `view` = { zoom, scrollY } in the reader's scene units. null when everything fits.
export function stackProgress(view, rect, layout) {
  const max = INSETS.top / view.zoom; // scrollY with the first page at the top
  const min = (rect.height - INSETS.bottom) / view.zoom - layout.totalH; // ...with the last page at the bottom
  if (!layout.n || !(max > min)) return null;
  const progress = Math.min(1, Math.max(0, (max - view.scrollY) / (max - min)));
  const visible = Math.min(1, Math.max(0, (rect.height - INSETS.top - INSETS.bottom) / view.zoom / layout.totalH));
  return { progress, visible };
}

// The scrollY that puts the document at `progress` (the inverse of stackProgress).
export function stackScrollY(progress, zoom, rect, layout) {
  const max = INSETS.top / zoom;
  const min = (rect.height - INSETS.bottom) / zoom - layout.totalH;
  return max - Math.min(1, Math.max(0, progress)) * (max - min);
}

// Book mode shows one page: the bar is a page slider (the thumb is one page long).
export const bookProgress = (index, n) => (n > 1 ? index / (n - 1) : 0);
export const bookPageAt = (progress, n) => Math.min(Math.max(n - 1, 0), Math.max(0, Math.round(progress * (n - 1))));

// The thumb inside a track of `trackH` px.
export function thumbBox(progress, visible, trackH) {
  const h = Math.min(trackH, Math.max(MIN_THUMB, visible * trackH));
  return { h, top: Math.min(1, Math.max(0, progress)) * (trackH - h) };
}

// The progress a thumb whose top edge is at `top` px stands for.
export function progressAt(top, h, trackH) {
  const room = trackH - h;
  return room > 0 ? Math.min(1, Math.max(0, top / room)) : 0;
}

// While the thumb is dragged: where its top edge goes, for a pointer at `pointerY` (px from the track's top) that took hold of it
// `grab` px below the thumb's top (a click on the bare track takes hold of the middle of the thumb).
export function dragTop(pointerY, grab, h, trackH) {
  return Math.min(Math.max(0, pointerY - grab), Math.max(0, trackH - h));
}
