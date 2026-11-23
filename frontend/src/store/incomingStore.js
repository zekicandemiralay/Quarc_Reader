import { create } from 'zustand';

// PDFs that reached the app from outside ("Open with…", the share sheet, a double-click on the
// desktop) and have not been added to the library yet. They wait here — also while nobody is
// signed in — until the library picks them up (see lib/openWith.js and pages/Library).
const useIncoming = create((set, get) => ({
  files: [],
  push: (files) => {
    if (files?.length) set((s) => ({ files: [...s.files, ...files] }));
  },
  take: () => {
    const files = get().files;
    if (files.length) set({ files: [] });
    return files;
  },
}));

export default useIncoming;
