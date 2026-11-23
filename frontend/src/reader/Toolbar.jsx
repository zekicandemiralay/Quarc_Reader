import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PenLine,
  Highlighter,
  Undo2,
  Redo2,
  Hand,
  Pointer,
  TextCursorInput,
  Shapes,
  SlidersHorizontal,
  Square,
  Circle,
  Diamond,
  MoveUpRight,
  Minus,
  Type,
  ImagePlus,
  Eraser,
  MousePointer2,
  Sparkles,
  ChevronDown,
  Crop,
} from 'lucide-react';
import Popover from '../components/Popover';
import ColorPanel from './ColorPanel';

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

// Icons for the MS-Paint-style cut selection (dashed marquee / dashed lasso).
export const RectSelectIcon = (
  <svg viewBox="0 0 20 20" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="5" width="13" height="10" rx="1" strokeDasharray="2.5 2.5" />
  </svg>
);
export const FreeformSelectIcon = (
  <svg viewBox="0 0 20 20" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 9.7c-.4-3.1 2.6-5.3 5.4-4.9 3.1.5 5.7 2.1 5.4 5.2-.3 2.9-3.1 4.7-5.9 4.6-2.3-.1-4.6-1.9-4.9-4.9z" strokeDasharray="2.5 2.5" />
  </svg>
);

// Every other tool Excalidraw has, shown in the "Tools" flyout instead of Excalidraw's own island.
// (The eraser is not here: it has its own button on the dock.)
const TOOLS = [
  ['selection', MousePointer2, 'select'],
  ['hand', Hand, 'hand'],
  ['rectangle', Square, 'rectangle'],
  ['diamond', Diamond, 'diamond'],
  ['ellipse', Circle, 'ellipse'],
  ['arrow', MoveUpRight, 'arrow'],
  ['line', Minus, 'line'],
  ['text', Type, 'text'],
  ['image', ImagePlus, 'image'],
];

function DockButton({ active, onClick, title, children, disabled, className = '', testId }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-sm font-medium transition disabled:opacity-30 ${
        active ? 'bg-accent text-white shadow-soft' : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
      } ${className}`}
    >
      {children}
    </button>
  );
}

const Divider = ({ className = '' }) => <div className={`mx-1 h-6 w-px shrink-0 bg-neutral-300/70 dark:bg-neutral-600/70 ${className}`} />;

// The preset colours, and (on a wide dock) the button that opens the rest: the colours used lately and the picker.
function Swatches({ colors, active, drawMode, isHl, onPick, inkFilter, wrap = false, more }) {
  const ring = (on) => (on ? 'ring-accent' : 'ring-transparent hover:ring-neutral-300 dark:hover:ring-neutral-500');
  return (
    <div className={`flex shrink-0 items-center ${wrap ? 'flex-wrap gap-2' : 'gap-1.5'}`} style={{ filter: inkFilter }}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={c}
          onClick={() => onPick({ color: c })}
          className={`h-6 w-6 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-surface transition dark:ring-offset-neutral-800 ${ring(drawMode && active.color === c)}`}
          style={{ backgroundColor: c, opacity: isHl ? 0.9 : 1 }}
        />
      ))}
      {more && more({ custom: !colors.includes(active.color), ring })}
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
          className={`flex h-10 w-9 shrink-0 items-center justify-center rounded-xl transition ${
            drawMode && active.size === s.size ? 'bg-neutral-200/80 dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
          }`}
        >
          <span className="rounded-full" style={{ width: s.dot, height: s.dot, backgroundColor: active.color, opacity: isHl ? 0.6 : 1, filter: inkFilter }} />
        </button>
      ))}
    </div>
  );
}

function Switch({ checked }) {
  return (
    <span className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-neutral-300 dark:bg-neutral-600'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[1.125rem]' : 'left-0.5'}`} />
    </span>
  );
}

// The reader's floating tool dock: pen, highlighter, text selection, colours, sizes, undo/redo, and a
// flyout with every other tool. It floats over the page (frosted), so the page keeps the whole screen.
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
  activeTool, // Excalidraw's active tool type
  cutMode, // null | 'rect' | 'freeform' — the cut selection
  onTool,
  onCut,
  eraserOn,
  onEraser,
  onSnip,
  penHistory = [], // colours used lately with the pen / the highlighter, newest first
  hlHistory = [],
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(null); // 'color' | 'more' | 'tools' | 'options'
  const colorBtn = useRef(null);
  const moreBtn = useRef(null);
  const toolsBtn = useRef(null);
  const optionsBtn = useRef(null);
  const isHl = drawMode === 'highlighter';
  const active = isHl ? highlighter : pen;
  const common = { active, drawMode, isHl, onPick: isHl ? onHighlighterChange : onPenChange, inkFilter };
  const colors = isHl ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const sizes = isHl ? HIGHLIGHTER_SIZES : PEN_SIZES;
  // Which colours the pen (or highlighter) was used with lately: the panel that opens from the colour buttons.
  const panel = { value: active.color, recent: isHl ? hlHistory : penHistory, onPick: common.onPick, inkFilter };

  // Is one of the "other" tools active (so the Tools button shows it)? The eraser has its own button.
  const otherTool = !textMode && !drawMode && !eraserOn ? (cutMode ? `cut-${cutMode}` : activeTool) : null;
  const CurrentToolIcon = (otherTool && TOOLS.find(([type]) => type === otherTool)?.[1]) || null;

  // The last circle of the colour row: opens the recent colours and the picker (it shows the colour when it is not a preset).
  const moreColors = ({ custom, ring }) => (
    <span ref={moreBtn} className="shrink-0">
      <button
        type="button"
        data-testid="color-more"
        title={t('canvas.moreColors')}
        aria-label={t('canvas.moreColors')}
        aria-expanded={menu === 'more'}
        onClick={() => setMenu(menu === 'more' ? null : 'more')}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-surface dark:ring-offset-neutral-800 ${ring(custom && drawMode)}`}
        style={{ background: custom ? active.color : 'conic-gradient(#f03e3e, #fab005, #40c057, #15aabf, #4c6ef5, #be4bdb, #f03e3e)' }}
      />
    </span>
  );
  const choose = (fn) => () => {
    setMenu(null);
    fn();
  };

  return (
    <div
      data-overlay
      data-dock
      data-finger={fingerDraws ? 'draws' : 'scrolls'}
      className="absolute left-1/2 top-3 z-[5] flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl border border-neutral-200/80 bg-surface/90 p-1.5 shadow-float backdrop-blur-xl [scrollbar-width:none] dark:border-neutral-700/80 dark:bg-neutral-800/90"
    >
      <DockButton active={drawMode === 'pen'} onClick={() => onDrawMode('pen')} title={t('canvas.pen')} testId="tool-pen">
        <PenLine size={18} />
      </DockButton>
      <DockButton active={isHl} onClick={() => onDrawMode('highlighter')} title={t('canvas.highlighter')} testId="tool-highlighter">
        <Highlighter size={18} />
      </DockButton>
      <DockButton active={eraserOn} onClick={onEraser} title={t('reader.tool.eraser')} testId="tool-eraser">
        <Eraser size={18} />
      </DockButton>
      <DockButton active={textMode} onClick={onTextMode} title={t('reader.selectText')} testId="tool-text-select">
        <TextCursorInput size={18} />
      </DockButton>
      <DockButton onClick={onSnip} title={t('snip.title')} testId="tool-snip">
        <Crop size={18} />
      </DockButton>
      <Divider />

      {/* Tablets/desktop: colours and sizes inline. */}
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        <Swatches colors={colors} {...common} more={moreColors} />
        <Divider />
        <Sizes sizes={sizes} {...common} />
        <Divider />
      </div>
      <Popover anchorRef={moreBtn} open={menu === 'more'} onClose={() => setMenu(null)} align="center" className="w-64 p-3">
        <ColorPanel {...panel} />
      </Popover>

      {/* Phones: behind one button showing the current colour and size. */}
      <span ref={colorBtn} className="shrink-0 sm:hidden">
        <button
          type="button"
          title={t('canvas.penColor')}
          onClick={() => setMenu(menu === 'color' ? null : 'color')}
          className="flex h-10 items-center gap-1.5 rounded-xl px-2 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60"
        >
          <span className="h-6 w-6 rounded-full ring-2 ring-white/70" style={{ backgroundColor: active.color, opacity: isHl ? 0.9 : 1, filter: inkFilter }} />
          <span className="rounded-full" style={{ width: Math.min(12, 3 + active.size), height: Math.min(12, 3 + active.size), backgroundColor: active.color, filter: inkFilter }} />
        </button>
      </span>
      <Popover anchorRef={colorBtn} open={menu === 'color'} onClose={() => setMenu(null)} className="max-h-[85vh] w-64 overflow-y-auto p-3">
        <ColorPanel {...panel} top={<Swatches colors={colors} {...common} wrap />} bottom={<Sizes sizes={sizes} {...common} />} />
      </Popover>
      <Divider className="sm:hidden" />

      <DockButton onClick={onUndo} title={t('canvas.undo')} testId="undo">
        <Undo2 size={18} />
      </DockButton>
      <DockButton onClick={onRedo} title={t('canvas.redo')} testId="redo">
        <Redo2 size={18} />
      </DockButton>
      <Divider />

      <DockButton active={fingerDraws} onClick={onToggleFinger} title={fingerDraws ? t('canvas.fingerDraws') : t('canvas.fingerScrolls')} testId="finger-toggle">
        {fingerDraws ? <Pointer size={18} /> : <Hand size={18} />}
      </DockButton>
      <span ref={toolsBtn} className="shrink-0">
        <DockButton active={!!otherTool} onClick={() => setMenu(menu === 'tools' ? null : 'tools')} title={t('reader.moreTools')} testId="tools-menu" className="gap-1">
          {CurrentToolIcon ? <CurrentToolIcon size={18} /> : otherTool?.startsWith('cut') ? (cutMode === 'freeform' ? FreeformSelectIcon : RectSelectIcon) : <Shapes size={18} />}
          <ChevronDown size={13} className="opacity-70" />
        </DockButton>
      </span>
      <span ref={optionsBtn} className="shrink-0">
        <DockButton onClick={() => setMenu(menu === 'options' ? null : 'options')} title={t('reader.drawingOptions')} testId="drawing-options">
          <SlidersHorizontal size={18} />
        </DockButton>
      </span>

      <Popover anchorRef={toolsBtn} open={menu === 'tools'} onClose={() => setMenu(null)} align="center" className="w-[17.5rem] p-2.5">
        <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('reader.moreTools')}</div>
        <div className="grid grid-cols-4 gap-1.5">
          {TOOLS.map(([type, Icon, label]) => (
            <button
              key={type}
              type="button"
              data-testid={`tool-${type}`}
              title={t(`reader.tool.${label}`)}
              onClick={choose(() => onTool(type))}
              className={`flex flex-col items-center gap-1 rounded-2xl px-1 py-2.5 text-[11px] transition ${
                otherTool === type ? 'bg-accent text-white shadow-soft' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
              }`}
            >
              <Icon size={19} />
              {t(`reader.tool.${label}`)}
            </button>
          ))}
          {[
            ['rect', RectSelectIcon, 'cutRect'],
            ['freeform', FreeformSelectIcon, 'cutFree'],
          ].map(([mode, icon, label]) => (
            <button
              key={mode}
              type="button"
              data-testid={`tool-cut-${mode}`}
              title={t(`reader.tool.${label}`)}
              onClick={choose(() => onCut(mode))}
              className={`flex flex-col items-center gap-1 rounded-2xl px-1 py-2.5 text-[11px] transition ${
                cutMode === mode && otherTool ? 'bg-accent text-white shadow-soft' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
              }`}
            >
              {icon}
              {t(`reader.tool.${label}`)}
            </button>
          ))}
        </div>
        <p className="mt-2 px-1 text-[11px] leading-snug text-neutral-400">{t('reader.cutHint')}</p>
      </Popover>

      <Popover anchorRef={optionsBtn} open={menu === 'options'} onClose={() => setMenu(null)} align="end" className="w-72 p-2">
        {[
          [shapeSnap, onToggleShapeSnap, t('canvas.shapeSnap'), t('canvas.shapeSnapHint'), Shapes],
          [snapText, onToggleSnapText, t('reader.snapText'), t('reader.snapTextHint'), Sparkles],
        ].map(([on, toggle, label, hint, Icon]) => (
          <button key={label} type="button" onClick={toggle} className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700/60">
            <Icon size={17} className="mt-0.5 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-neutral-500">{hint}</span>
            </span>
            <Switch checked={on} />
          </button>
        ))}
      </Popover>
    </div>
  );
}
