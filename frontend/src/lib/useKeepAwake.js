import { useEffect } from 'react';
import { keepAwake } from './keepAwake';

// Keeps the screen on for as long as `active` is true (and the component is on screen).
export default function useKeepAwake(active) {
  useEffect(() => (active ? keepAwake() : undefined), [active]);
}
