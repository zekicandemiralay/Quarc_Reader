import { useTranslation } from 'react-i18next';
import ColorPicker from './ColorPicker';

// What opens from the colour button: the colours used lately (newest first), then the picker. `top` and `bottom`
// are extra rows for narrow screens, where the preset colours and the sizes live in this panel too.
export default function ColorPanel({ value, recent, onPick, inkFilter, top, bottom }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      {top}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('canvas.recentColors')}</div>
        {recent.length ? (
          <div data-testid="recent-colors" className="flex flex-wrap gap-2" style={{ filter: inkFilter }}>
            {recent.map((c) => (
              <button
                key={c}
                type="button"
                data-testid="recent-color"
                data-color={c}
                title={c}
                aria-label={`${t('canvas.recentColor')} ${c}`}
                onClick={() => onPick({ color: c })}
                className={`h-6 w-6 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-surface transition dark:ring-offset-neutral-800 ${
                  value?.toLowerCase() === c ? 'ring-accent' : 'ring-transparent hover:ring-neutral-300 dark:hover:ring-neutral-500'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs leading-snug text-neutral-400">{t('canvas.recentEmpty')}</p>
        )}
      </div>
      <ColorPicker value={value} onCommit={(color) => onPick({ color })} />
      {bottom}
    </div>
  );
}
