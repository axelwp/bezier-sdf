import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveGraphic, type LiveGraphicBackdrop } from '@bezier-sdf/react';

/**
 * Draw a colorful gradient-and-blob backdrop to a canvas and return it.
 * Gives the demo a non-trivial image to refract without shipping a
 * binary file in public/. A photo uploaded by the user takes its place.
 */
function makeBackdropCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 1280;
  const ctx = c.getContext('2d')!;

  // Diagonal base gradient.
  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0,    '#1b2a6b');
  g.addColorStop(0.45, '#c2185b');
  g.addColorStop(1,    '#ffb74d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);

  // Radial color "blobs" so refraction has sharp features to bend, not
  // just a smooth gradient (which can hide the effect).
  const blobs: Array<[number, number, number, string]> = [
    [0.22, 0.28, 480, '#00e5ff'],
    [0.72, 0.18, 420, '#ffd54f'],
    [0.50, 0.68, 560, '#ff4081'],
    [0.85, 0.78, 380, '#b388ff'],
    [0.12, 0.82, 360, '#69f0ae'],
  ];
  for (const [fx, fy, r, color] of blobs) {
    const cx = fx * c.width;
    const cy = fy * c.height;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0,   color);
    rg.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Grid overlay so displacement of straight lines reads immediately as
  // refraction when you look through the lens.
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2;
  const step = 80;
  for (let x = 0; x <= c.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, c.height);
    ctx.stroke();
  }
  for (let y = 0; y <= c.height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
    ctx.stroke();
  }

  return c;
}

type GlassKnobs = {
  refractionStrength: number;
  chromaticStrength: number;
  fresnelStrength: number;
  tintStrength: number;
  frostStrength: number;
  rimColor: string;
  tintColor: string;
};

const DEFAULTS: GlassKnobs = {
  refractionStrength: 0.05,
  chromaticStrength:  0.015,
  fresnelStrength:    0.3,
  tintStrength:       0.1,
  frostStrength:      2.5,
  rimColor:  '#ffffff',
  tintColor: '#e8f0ff',
};

const SLIDERS: Array<{ key: keyof GlassKnobs; label: string; min: number; max: number; step: number }> = [
  { key: 'refractionStrength', label: 'refraction',    min: 0, max: 0.25, step: 0.005 },
  { key: 'chromaticStrength',  label: 'chromatic',     min: 0, max: 0.1,  step: 0.001 },
  { key: 'fresnelStrength',    label: 'fresnel rim',   min: 0, max: 1.5,  step: 0.01 },
  { key: 'tintStrength',       label: 'tint strength', min: 0, max: 1,    step: 0.01 },
  { key: 'frostStrength',      label: 'frost (px)',    min: 0, max: 10,   step: 0.1  },
];

function App() {
  const [knobs, setKnobs] = useState<GlassKnobs>(DEFAULTS);
  const [userBackdrop, setUserBackdrop] = useState<HTMLImageElement | null>(null);
  const defaultBackdrop = useMemo(() => makeBackdropCanvas(), []);
  const backdrop: LiveGraphicBackdrop = userBackdrop ?? defaultBackdrop;
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickImage = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setUserBackdrop(img);
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  const set = <K extends keyof GlassKnobs>(k: K, v: GlassKnobs[K]) =>
    setKnobs((x) => ({ ...x, [k]: v }));

  // Paint backdrop behind the canvas so the lens feels like it's sitting
  // on top of something real. The refraction shader samples the *upload-
  // ed* backdrop texture, not this DOM background — but having them
  // match makes the illusion convincing.
  useEffect(() => {
    const bg = userBackdrop
      ? `url(${userBackdrop.src})`
      : `url(${defaultBackdrop.toDataURL()})`;
    document.body.style.backgroundImage = bg;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
  }, [userBackdrop, defaultBackdrop]);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <LiveGraphic
          src="/logo.svg"
          effect={{ name: 'liquid-glass', ...knobs }}
          backdrop={backdrop}
          style={{ width: 'min(62vw, 62vh)', aspectRatio: '1 / 1' }}
          ariaLabel="liquid-glass logo"
          onError={(e) => console.error(e)}
        />
      </div>

      <Panel
        knobs={knobs}
        onChange={set}
        onReset={() => setKnobs(DEFAULTS)}
        onUpload={() => fileRef.current?.click()}
        hasUpload={!!userBackdrop}
        onClearUpload={() => setUserBackdrop(null)}
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPickImage(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function Panel({
  knobs,
  onChange,
  onReset,
  onUpload,
  hasUpload,
  onClearUpload,
}: {
  knobs: GlassKnobs;
  onChange: <K extends keyof GlassKnobs>(k: K, v: GlassKnobs[K]) => void;
  onReset: () => void;
  onUpload: () => void;
  hasUpload: boolean;
  onClearUpload: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        left: 20,
        padding: '14px 16px',
        background: 'rgba(10, 10, 12, 0.72)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 10,
        fontSize: 12,
        width: 280,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ opacity: 0.7, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        liquid-glass
      </div>

      {SLIDERS.map((s) => (
        <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 90, opacity: 0.8 }}>{s.label}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={knobs[s.key] as number}
            onChange={(e) => onChange(s.key, Number(e.target.value) as GlassKnobs[typeof s.key])}
            style={{ flex: 1 }}
          />
          <code style={{ width: 52, textAlign: 'right', opacity: 0.9 }}>
            {(knobs[s.key] as number).toFixed(s.step < 0.01 ? 3 : 2)}
          </code>
        </label>
      ))}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 90, opacity: 0.8 }}>rim color</span>
        <input
          type="color"
          value={knobs.rimColor}
          onChange={(e) => onChange('rimColor', e.target.value)}
        />
        <code style={{ opacity: 0.9 }}>{knobs.rimColor}</code>
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 90, opacity: 0.8 }}>tint color</span>
        <input
          type="color"
          value={knobs.tintColor}
          onChange={(e) => onChange('tintColor', e.target.value)}
        />
        <code style={{ opacity: 0.9 }}>{knobs.tintColor}</code>
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={onReset} style={btn}>reset</button>
        <button type="button" onClick={onUpload} style={btn}>
          {hasUpload ? 'replace image' : 'upload image'}
        </button>
        {hasUpload ? (
          <button type="button" onClick={onClearUpload} style={btn}>default</button>
        ) : null}
      </div>

      <div style={{ opacity: 0.5, fontSize: 11, lineHeight: 1.5 }}>
        The lens smooth-unions the SVG paths into one silhouette and refracts
        the backdrop through it using the SDF gradient as a surface normal.
        Per-path colors and other effects are ignored in glass mode.
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  flex: 1,
  padding: '6px 10px',
  fontFamily: 'inherit',
  fontSize: 12,
  background: 'rgba(255,255,255,0.07)',
  color: '#eee',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6,
  cursor: 'pointer',
};

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
