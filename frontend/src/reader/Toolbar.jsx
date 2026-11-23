import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PenLine, Highlighter, Undo2, Redo2, Shapes, Hand, Pointer, TextCursorInput, Sparkles } from 'lucide-react';
import Popover from '../components/Popover';

export const PEN_COLORS = ['#1f2937', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#7048e8'];
export const HIGHLIGHTER_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffc078'];
export const PEN_SIZES = [
  { size: 1, dot: 4 },
  { size: 2.5, dot: 7 },
  { size: 5, dot: 11 },
  { size: 9, dot: 15 },
];
export const HIGHLIGHTER_SIZES = [
  { size: 8, dot: 9 },
  { size: 14, dot: 13 },
  { size: 22, dot: 17 },
];

function ToolButton({ active, onClick, title, children, disabled, className = '' }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium transition disabled:opacity-30 ${
        active ? 'bg-accent text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-700/70'
      } ${className}`}
    >
      {children}
    </button>
  );
}

const Divider = ({ className = '' }) => <div className={`mx-1 h-6 w-px shrink-0 bg-neutral-300 dark:bg-neutral-700 ${className}`} />;

function Swatches({ colors, active, drawMode, isHl, onPick, inkFilter, wrap = false }) {
  const { t } = useTranslation();
  const custom = !colors.includes(active.color);
  const ring = (on) => (on ? 'ring-accent' : 'ring-transparent hover:ring-neutral-300');
  return (
    <div className={`flex shrink-0 items-center ${wrap ? 'flex-wrap gap-2' : 'gap-1'}`} style={{ filter: inkFilter }}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={c}
          onClick={() => onPick({ color: c })}
          className={`h-7 w-7 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-white transition dark:ring-offset-neutral-900 ${ring(drawMode && active.color === c)}`}
          style={{ backgroundColor: c, opacity: isHl ? 0.85 : 1 }}
        />
      ))}
      <label
        title={t('canvas.customColor')}
        className={`relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900 ${ring(custom && drawMode)}`}
        style={{ background: custom ? active.color : 'conic-gradient(#f03e3e, #fab005, #40c057, #15aabf, #4c6ef5, #be4bdb, #f03e3e)' }}
      >
        <input
          type="color"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={/^#[0-9a-f]{6}$/i.test(active.color) ? active.color : '#000000'}
          onChange={(e) => onPick({ color: e.target.value })}
        />
      </label>
    </div>
  );
}

function Sizes({ sizes, active, drawMode, isHl, onPick, inkFilter }) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {sizes.map((s) => (
        <button
          key={s.size}
          type="button"
          title={`${t('canvas.penSize')} ${s.size}`}
          aria-label={`${t('canvas.penSize')} ${s.size}`}
          onClick={() => onPick({ size: s.size })}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${
            drawMode && active.size === s.size ? 'bg-neutral-200 dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
          }`}
        >
          <span className="rounded-full" style={{ width: s.dot, height: s.dot, backgroundColor: active.color, opacity: isHl ? 0.6 : 1, filter: inkFilter }} />
        </button>
      ))}
    </div>
  );
}

// The reader's tool row: pen, highlighter, text selection, colours, sizes,
// undo/redo and the handwriting preferences. Excalidraw's own tool island
// (shapes, text, eraser, selection...) floats on the canvas beneath it.
export default function Toolbar({
  drawMode, // 'pen' | 'highlighter' | null (another tool is active)
  textMode,
  onDrawMode,
  onTextMode,
  pen,
  highlighter,
  onPenChange,
  onHighlighterChange,
  snapText,
  onToggleSnapText,
  shapeSnap,
  onToggleShapeSnap,
  fingerDraws,
  onToggleFinger,
  onUndo,
  onRedo,
  inkFilter,
}) {
  const { t } = useTranslation();
  const [penMenu, setPenMenu] = useState(false);
  const penBtn = useRef(null);
  const isHl = drawMode === 'highlighter';
  const active = isHl ? highlighter : pen;
  const common = { active, drawMode, isHl, onPick: isHl ? onHighlighterChange : onPenChange, inkFilter };
  const colors = isHl ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const sizes = isHl ? HIGHLIGHTER_SIZES : PEN_SIZES;

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-white/90 px-2 py-1.5 backdrop-blur [scrollbar-width:none] dark:border-neutral-800 dark:bg-neutral-900/90">
      <ToolButton active={drawMode === 'pen'} onClick={() => onDrawMode('pen')} title={t('canvas.pen')}>
        <PenLine size={18} />
      </ToolButton>
      <ToolButton active={isHl} onClick={() => onDrawMode('highlighter')} title={t('canvas.highlighter')}>
        <Highlighter size={18} />
      </ToolButton>
      <ToolButton active={textMode} onClick={onTextMode} title={t('reader.selectText')}>
        <TextCursorInput size={18} />
      </ToolButton>
      <Divider />

      {/* Tablets/desktop: colours and sizes inline. */}
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        <Swatches colors={colors} {...common} />
        <Divider />
        <Sizes sizes={sizes} {...common} />
        <Divider />
      </div>

      {/* Phones: behind one button showing the current colour and size. */}
      <span ref={penBtn} className="shrink-0 sm:hidden">
        <button
          type="button"
          title={t('canvas.penColor')}
          onClick={() => setPenMenu((v) => !v)}
          className="flex h-9 items-center gap-1.5 rounded-lg px-2 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/70"
        >
          <span className="h-6 w-6 rounded-full" style={{ backgroundColor: active.color, opacity: isHl ? 0.85 : 1, filter: inkFilter }} />
          <span className="rounded-full" style={{ width: Math.min(12, 3 + active.size), height: Math.min(12, 3 + active.size), backgroundColor: active.color, filter: inkFilter }} />
        </button>
      </span>
      <Popover anchorRef={penBtn} open={penMenu} onClose={() => setPenMenu(false)} className="w-64 p-3">
        <div className="flex flex-col gap-3">
          <Swatches colors={colors} {...common} wrap />
          <Sizes sizes={sizes} {...common} />
        </div>
      </Popover>
      <Divider className="sm:hidden" />

      <ToolButton onClick={onUndo} title={t('canvas.undo')}>
        <Undo2 size={18} />
      </ToolButton>
      <ToolButton onClick={onRedo} title={t('canvas.redo')}>
        <Redo2 size={18} />
      </ToolButton>

      <div className="min-w-2 flex-1" />

      {isHl && (
        <ToolButton active={snapText} onClick={onToggleSnapText} title={t('reader.snapTextHint')}>
          <Sparkles size={18} />
          <span className="hidden lg:inline">{t('reader.snapText')}</span>
        </ToolButton>
      )}
      <ToolButton active={shapeSnap} onClick={onToggleShapeSnap} title={t('canvas.shapeSnapHint')}>
        <Shapes size={18} />
        <span className="hidden lg:inline">{t('canvas.shapeSnap')}</span>
      </ToolButton>
      <ToolButton active={fingerDraws} onClick={onToggleFinger} title={fingerDraws ? t('canvas.fingerDraws') : t('canvas.fingerScrolls')}>
        {fingerDraws ? <Pointer size={18} /> : <Hand size={18} />}
        <span className="hidden lg:inline">{fingerDraws ? t('canvas.fingerDrawsShort') : t('canvas.fingerScrollsShort')}</span>
      </ToolButton>
    </div>
  );
}
