// One undo timeline for everything the person does in a document — strokes, shapes, text, highlights, notes on a
// highlight, inserted or deleted note pages, bookmarks — in the order they happened.
//
// Excalidraw has an undo of its own, but it only knows its drawing, and the reader even clears it whenever the page
// layout changes (its positions would be wrong after pages shift). So the reader keeps this one instead: each step is
// { undo(), redo() } and knows how to take itself back by itself (ink steps are stored per page, like the saved ink, so
// they survive pages being inserted above them).
//
//   record(op)   a new step; whatever could be redone is gone
//   batch(fn)    everything recorded while fn runs is ONE step (an eraser stroke that removes ink and highlights)
//   undo(), redo()   run one step; they queue, so pressing Ctrl+Z quickly does not interleave two async steps

export class History {
  constructor({ limit = 400, onError = (err) => console.error('[Quarc Reader] undo/redo failed', err) } = {}) {
    this.limit = limit;
    this.onError = onError;
    this.undoStack = [];
    this.redoStack = [];
    this.batching = null;
    this.chain = Promise.resolve();
    this.listeners = new Set();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  record(op) {
    if (this.batching) {
      this.batching.push(op);
      return;
    }
    this.undoStack.push(op);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit();
  }

  batch(fn) {
    if (this.batching) return fn(); // inside a batch already: joins it
    this.batching = [];
    try {
      return fn();
    } finally {
      const ops = this.batching;
      this.batching = null;
      if (ops.length === 1) this.record(ops[0]);
      else if (ops.length > 1) {
        this.record({
          undo: async () => {
            for (const op of [...ops].reverse()) await op.undo();
          },
          redo: async () => {
            for (const op of ops) await op.redo();
          },
        });
      }
    }
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  undo() {
    return this.run(this.undoStack, this.redoStack, 'undo');
  }

  redo() {
    return this.run(this.redoStack, this.undoStack, 'redo');
  }

  // Resolves to whether a step was taken.
  run(from, to, how) {
    const job = this.chain.then(async () => {
      const op = from.pop();
      if (!op) return false;
      try {
        await op[how]();
      } catch (err) {
        this.onError(err); // a step that failed is dropped rather than left half-done on a stack
        this.emit();
        return false;
      }
      to.push(op);
      this.emit();
      return true;
    });
    this.chain = job.catch(() => {});
    return job;
  }
}
