import type { AppSettings, ColorPalette, GlowPattern, LyricStyle } from '../types';
import { rgbToHex } from '../utils/color';

type Update = (fn: (s: AppSettings) => AppSettings) => void;

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'seg-on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; step?: number; fmt?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="row">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <span className="val">{p.fmt ? p.fmt(p.value) : p.value}</span>
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        {hint && <span className="block muted text-xs">{hint}</span>}
      </span>
      <button role="switch" aria-checked={checked} className={`switch ${checked ? 'switch-on' : ''}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  );
}

export function GlowControls({ settings, update, palette }: { settings: AppSettings; update: Update; palette: ColorPalette }) {
  const g = settings.glow;
  const set = (patch: Partial<typeof g>) => update((s) => ({ ...s, glow: { ...s.glow, ...patch } }));
  return (
    <div className="card space-y-4">
      <Toggle label="Edge lighting" checked={g.enabled} onChange={(enabled) => set({ enabled })} />
      <div className="space-y-2">
        <span className="label">Motion</span>
        <Seg<GlowPattern>
          value={g.pattern}
          onChange={(pattern) => set({ pattern })}
          options={[
            ['flow', 'Flow'],
            ['pulse', 'Beat pulse'],
            ['breathe', 'Breathe'],
            ['still', 'Still'],
          ]}
        />
      </div>
      <Slider label="Brightness" value={g.brightness} min={0.4} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(brightness) => set({ brightness })} />
      <Slider label="Thickness" value={g.thickness} min={3} max={60} onChange={(thickness) => set({ thickness })} fmt={(v) => `${v}px`} />
      <Slider label="Glow spread" value={g.glow} min={10} max={160} onChange={(glow) => set({ glow })} fmt={(v) => `${v}px`} />
      <Slider label="Beat reaction" value={g.reactivity} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(reactivity) => set({ reactivity })} />
      <Slider label="Speed" value={g.speed} min={0.2} max={3} step={0.1} fmt={(v) => `${v.toFixed(1)}×`} onChange={(speed) => set({ speed })} />
      <div className="space-y-2">
        <span className="label">Colours</span>
        <Seg<'album' | 'custom'>
          value={g.colorMode}
          onChange={(colorMode) => set({ colorMode })}
          options={[
            ['album', 'From album art'],
            ['custom', 'My colours'],
          ]}
        />
        <div className="flex items-center gap-2 pt-1">
          {g.colorMode === 'album'
            ? [palette.primary, palette.secondary, palette.accent].map((c) => <span key={c} className="swatch" style={{ background: c }} title={rgbToHex(c)} />)
            : g.custom.map((c, i) => (
                <input
                  key={i}
                  type="color"
                  className="swatch-input"
                  value={c}
                  onChange={(e) => {
                    const custom = [...g.custom] as typeof g.custom;
                    custom[i] = e.target.value;
                    set({ custom });
                  }}
                />
              ))}
        </div>
      </div>
    </div>
  );
}

export function LyricsControls({ settings, update, desktop }: { settings: AppSettings; update: Update; desktop: boolean }) {
  const l = settings.lyrics;
  const set = (patch: Partial<typeof l>) => update((s) => ({ ...s, lyrics: { ...s.lyrics, ...patch } }));
  return (
    <div className="card space-y-4">
      {desktop && <Toggle label="Lyrics on screen" hint="Shown over everything, clicks pass through" checked={l.onOverlay} onChange={(onOverlay) => set({ onOverlay })} />}
      <div className="space-y-2">
        <span className="label">Style</span>
        <Seg<LyricStyle>
          value={l.style}
          onChange={(style) => set({ style })}
          options={[
            ['sweep', 'Sweep'],
            ['pop', 'Word pop'],
            ['line', 'Line'],
          ]}
        />
      </div>
      {desktop && (
        <div className="space-y-2">
          <span className="label">Position on screen</span>
          <Seg<'bottom' | 'center' | 'top'>
            value={l.position}
            onChange={(position) => set({ position })}
            options={[
              ['top', 'Top'],
              ['center', 'Centre'],
              ['bottom', 'Bottom'],
            ]}
          />
        </div>
      )}
      <Slider label="Text size" value={l.size} min={24} max={96} onChange={(size) => set({ size })} fmt={(v) => `${v}px`} />
      <Slider
        label="Timing"
        value={l.offsetMs}
        min={-1500}
        max={1500}
        step={50}
        onChange={(offsetMs) => set({ offsetMs })}
        fmt={(v) => (v === 0 ? 'in sync' : `${v > 0 ? 'later' : 'earlier'} ${Math.abs(v) / 1000}s`)}
      />
      <Toggle label="Show next line" checked={l.showNext} onChange={(showNext) => set({ showNext })} />
      {desktop && <Toggle label="Shadow behind text" hint="Keeps lyrics readable over bright windows" checked={l.backdrop} onChange={(backdrop) => set({ backdrop })} />}
    </div>
  );
}
