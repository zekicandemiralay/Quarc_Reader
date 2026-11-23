import { create } from 'zustand';

// Per-device preferences (not synced), stored in localStorage — same pattern as
// the other Quarc apps' settings stores.
const KEY = 'quarc_reader_settings';

// Bump when a default changes in a way that should reach people who already have settings saved
// (every update() saves the whole object, so an old default would otherwise stay forever).
const SETTINGS_VERSION = 2;

const DEFAULTS = {
  settingsVersion: SETTINGS_VERSION,
  theme: 'system', // 'light' | 'dark' | 'system'
  // Paper: how the page itself looks while reading.
  paperMode: 'sepia', // 'sepia' | 'white' | 'dark' | 'auto' (follow the theme: white in light mode, dark in dark mode)
  // Handwriting (same as Quarc Notes)
  fingerMode: 'auto', // 'auto' | 'draw' | 'scroll' — auto: draw until a stylus is used here, then scroll
  penSeen: false, // a stylus has been used on this device
  shapeSnap: true, // hold the pen still at the end of a stroke to turn it into a clean shape
  tool: 'pen', // 'pen' | 'highlighter'
  penSize: 2.5,
  penColor: '#1f2937',
  hlSize: 14,
  hlColor: '#ffd43b',
  snapText: true, // a pencil highlighter stroke over text becomes a real text highlight (otherwise: freehand ink)
  // Library
  syncChoice: 'ask', // what to do with a newly added PDF: 'ask' | 'local' | 'cloud'
  autoCache: true, // keep synced documents on this device after the first time they are opened
  libraryView: 'grid', // 'grid' | 'list'
  librarySort: 'recent', // 'recent' | 'title' | 'added'
  // Reading
  readMode: 'ask', // 'ask' (every time a document is opened) | 'scroll' | 'book'
  pageTurn: 'swipe', // book mode: 'swipe' | 'tap' (tap the screen edges) | 'both'
};

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Settings saved before version 2 hold the old defaults (white paper, scroll): drop those two
    // so the new defaults apply once. Anything the person set since is kept.
    if ((stored.settingsVersion || 1) < SETTINGS_VERSION) {
      delete stored.readMode;
      delete stored.paperMode;
    }
    return { ...DEFAULTS, ...stored, settingsVersion: SETTINGS_VERSION };
  } catch {
    return { ...DEFAULTS };
  }
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolveDark(theme) {
  return theme === 'dark' || (theme === 'system' && !!media?.matches);
}

export function applyTheme(theme) {
  const dark = resolveDark(theme);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#171717' : '#fafafa');
  useSettings.setState({ isDark: dark });
}

const useSettings = create((set, get) => ({
  ...load(),
  isDark: false,
  update(patch) {
    set(patch);
    const { update, isDark, ...persist } = get(); // eslint-disable-line no-unused-vars
    try {
      localStorage.setItem(KEY, JSON.stringify(persist));
    } catch {
      /* storage unavailable: setting still applies for this session */
    }
    if (patch.theme) applyTheme(patch.theme);
  },
}));

// Follow the OS while the theme is "system".
media?.addEventListener?.('change', () => {
  if (useSettings.getState().theme === 'system') applyTheme('system');
});

// The paper actually shown: whether the page is drawn dark, and its tint.
export function resolvePaper(paperMode, isDark) {
  if (paperMode === 'auto') return isDark ? 'dark' : 'white';
  return paperMode;
}

export default useSettings;
