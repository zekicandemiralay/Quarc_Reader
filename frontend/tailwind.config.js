/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Violet, from the logo. `accent` keeps its name from the other Quarc apps so every
        // `bg-accent` / `text-accent` in the code follows the new identity.
        accent: {
          DEFAULT: '#7c3aed',
          dark: '#6d28d9',
          soft: '#f1e9ff',
          ring: '#c4a6ff',
        },
        // The neutral scale is warm paper tones in the light end and a deep aubergine in the dark
        // end, instead of Tailwind's cold grey — so the whole app (and the shared Store kit
        // components that use `neutral-*`) reads as a book, not a dashboard.
        neutral: {
          50: '#faf8f4',
          100: '#f3efe7',
          200: '#e6dfd2',
          300: '#d2c8b5',
          400: '#a59c8d',
          500: '#797263',
          600: '#585246',
          700: '#3c3745',
          800: '#272333',
          900: '#1c1827',
          950: '#130f1b',
        },
        surface: '#fffdf9', // cards, sheets and bars in light mode
        sepia: { 100: '#f7f0df', 200: '#eee3c9', 300: '#e0d1ac', 400: '#cbb888' },
      },
      fontFamily: {
        // Titles and anything that should feel like print. System serifs only: nothing to
        // download, so it is instant and works offline.
        serif: ['"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', '"Book Antiqua"', 'Charter', 'Georgia', '"Noto Serif"', 'serif'],
      },
      boxShadow: {
        // A book standing on a shelf.
        cover: '0 1px 1px rgb(58 40 20 / 0.20), 0 10px 20px -8px rgb(58 40 20 / 0.45), 0 3px 8px -2px rgb(58 40 20 / 0.18)',
        'cover-hover': '0 1px 1px rgb(58 40 20 / 0.22), 0 18px 30px -10px rgb(58 40 20 / 0.5), 0 6px 12px -3px rgb(58 40 20 / 0.2)',
        // Things that float over the page: the tool dock, the page pill, popovers.
        float: '0 12px 32px -10px rgb(36 22 66 / 0.35), 0 3px 8px rgb(36 22 66 / 0.10)',
        soft: '0 1px 2px rgb(58 40 20 / 0.06), 0 4px 12px -4px rgb(58 40 20 / 0.10)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
};
