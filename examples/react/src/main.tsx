import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  LiveGraphic,
  type LiveGraphicEffectName,
  type LiveGraphicEffectSpec,
  type LiveGraphicHandle,
  type LiveGraphicProps,
} from '@bezier-sdf/react';
import './styles.css';

// Frame-based effects are the ones whose chips share the `active` record
// and per-name slider config. `liquid-glass` and `morph` each run a
// separate GPU pipeline driven by their own playground state, so they
// stay out of these record shapes.
type FrameEffectName = Exclude<LiveGraphicEffectName, 'liquid-glass' | 'morph'>;

const GLASS_DEFAULTS = {
  refractionStrength: 0.05,
  chromaticStrength:  0.015,
  fresnelStrength:    0.3,
  tintStrength:       0.1,
  frostStrength:      2.5,
  rimColor:  '#ffffff',
  tintColor: '#e8f0ff',
} as const;

// Colorful gradient + blobs + grid so refraction has something to bend.
// Matches the dedicated liquid-glass demo so both read consistently.
function makeGlassBackdrop(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const ctx = c.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0,    '#1b2a6b');
  g.addColorStop(0.45, '#c2185b');
  g.addColorStop(1,    '#ffb74d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);

  const blobs: Array<[number, number, number, string]> = [
    [0.22, 0.28, 280, '#00e5ff'],
    [0.72, 0.18, 240, '#ffd54f'],
    [0.50, 0.68, 320, '#ff4081'],
    [0.85, 0.78, 220, '#b388ff'],
    [0.12, 0.82, 200, '#69f0ae'],
  ];
  for (const [fx, fy, r, color] of blobs) {
    const cx = fx * c.width;
    const cy = fy * c.height;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2;
  const step = 60;
  for (let x = 0; x <= c.width; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke();
  }
  for (let y = 0; y <= c.height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
  }

  return c;
}

const DEFAULT_SRC = '/logo.svg';
const THEME_KEY = 'bezier-sdf:theme';
type Theme = 'dark' | 'light';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

interface CardSpec {
  id: string;
  number: string;
  title: string;
  /** Omit to render with the SVG's own per-path fill/stroke paint. */
  color?: string;
  effect: LiveGraphicProps['effect'];
  autoPlay?: boolean;
  code: string;
  hint?: string;
  replay?: boolean;
  /** Provide a backdrop canvas for the liquid-glass material to refract. */
  backdrop?: boolean;
  /** Show a backdrop upload button in the replay slot. */
  backdropUpload?: boolean;
  /** Target SVG for the `morph` effect. */
  to?: string;
  /** End color (`t = 1`) for the `morph` effect. Falls back to `color`. */
  toFillColor?: string;
  /** Show a "target SVG" upload button (parallels `backdropUpload`). */
  toUpload?: boolean;
}

const CARDS: CardSpec[] = [
  {
    id: 'native-paint',
    number: '01',
    title: 'Native SVG paint',
    effect: 'none',
    code: `<LiveGraphic src={src} />`,
    hint: 'per-path fills/strokes',
  },
  {
    id: 'reveal-auto',
    number: '02',
    title: 'Reveal · autoplay',
    color: '#ff3a7a',
    effect: 'reveal',
    autoPlay: true,
    code: `<LiveGraphic effect="reveal" autoPlay />`,
    replay: true,
  },
  {
    id: 'ripple',
    number: '03',
    title: 'Ripple',
    color: '#9af078',
    effect: 'ripple',
    code: `<LiveGraphic effect="ripple" />`,
    hint: 'click the plate',
  },
  {
    id: 'liquid',
    number: '04',
    title: 'Liquid cursor',
    color: '#ffb84d',
    effect: 'liquid-cursor',
    code: `<LiveGraphic effect="liquid-cursor" />`,
    hint: 'hover the plate',
  },
  {
    id: 'combo',
    number: '05',
    title: 'Liquid cursor + ripple',
    color: '#d78aff',
    effect: ['liquid-cursor', 'ripple'],
    code: `<LiveGraphic effect={['liquid-cursor','ripple']} />`,
    hint: 'hover, then click',
  },
  {
    id: 'liquid-glass',
    number: '06',
    title: 'Liquid glass',
    effect: { name: 'liquid-glass', ...GLASS_DEFAULTS },
    code: `<LiveGraphic effect={{ name: 'liquid-glass' }} backdrop={img} />`,
    hint: 'refracts the backdrop',
    backdrop: true,
    backdropUpload: true,
  },
  {
    id: 'morph',
    number: '07',
    title: 'Morph',
    color: '#ff3a7a',
    toFillColor: '#10c8ff',
    to: '/morph-circle.svg',
    effect: 'morph',
    code: `<LiveGraphic effect="morph" to={target} />`,
    hint: 'hover to morph; upload a target SVG',
    toUpload: true,
  },
];

/* ============================== playground ============================== */

type GlassNumericParams = {
  refractionStrength: number;
  chromaticStrength: number;
  fresnelStrength: number;
  tintStrength: number;
  frostStrength: number;
};

type PlaygroundParams = {
  reveal: { duration: number; startOffset: number; sminK: number };
  ripple: { speed: number; duration: number; amplitude: number; decay: number };
  'liquid-cursor': { pull: number; radius: number; lerp: number };
  glass: GlassNumericParams;
  morph: { rate: number };
};

const MORPH_DEFAULT_TO = '/morph-circle.svg';
const MORPH_DEFAULT_TO_COLOR = '#10c8ff';

const DEFAULT_PARAMS: PlaygroundParams = {
  reveal: { duration: 1400, startOffset: 0.3, sminK: 0.08 },
  ripple: { speed: 2.8, duration: 0.9, amplitude: 0.08, decay: 3.5 },
  'liquid-cursor': { pull: 0.08, radius: 0.15, lerp: 0.5 },
  glass: {
    refractionStrength: GLASS_DEFAULTS.refractionStrength,
    chromaticStrength:  GLASS_DEFAULTS.chromaticStrength,
    fresnelStrength:    GLASS_DEFAULTS.fresnelStrength,
    tintStrength:       GLASS_DEFAULTS.tintStrength,
    frostStrength:      GLASS_DEFAULTS.frostStrength,
  },
  morph: { rate: 15 },
};

interface SliderSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

const PARAM_UI: Record<FrameEffectName, SliderSpec[]> = {
  reveal: [
    { key: 'duration',    label: 'duration (ms)', min: 200, max: 4000, step: 50 },
    { key: 'startOffset', label: 'start offset',  min: 0,   max: 1,    step: 0.01 },
    { key: 'sminK',       label: 'smin k',        min: 0,   max: 0.5,  step: 0.005 },
  ],
  ripple: [
    { key: 'speed',     label: 'speed',     min: 0.5, max: 8,   step: 0.05 },
    { key: 'duration',  label: 'duration',  min: 0.1, max: 3,   step: 0.05 },
    { key: 'amplitude', label: 'amplitude', min: 0,   max: 0.2, step: 0.005 },
    { key: 'decay',     label: 'decay',     min: 0.5, max: 10,  step: 0.1 },
  ],
  'liquid-cursor': [
    { key: 'pull',   label: 'pull',   min: 0,    max: 0.3, step: 0.005 },
    { key: 'radius', label: 'radius', min: 0.02, max: 0.5, step: 0.005 },
    { key: 'lerp',   label: 'lerp',   min: 0.05, max: 1,   step: 0.01 },
  ],
};

const GLASS_PARAM_UI: SliderSpec[] = [
  { key: 'refractionStrength', label: 'refraction', min: 0, max: 0.2,  step: 0.005 },
  { key: 'chromaticStrength',  label: 'chromatic',  min: 0, max: 0.1,  step: 0.001 },
  { key: 'fresnelStrength',    label: 'fresnel',    min: 0, max: 1,    step: 0.01 },
  { key: 'tintStrength',       label: 'tint',       min: 0, max: 1,    step: 0.01 },
  { key: 'frostStrength',      label: 'frost',      min: 0, max: 8,    step: 0.1 },
];

const MORPH_PARAM_UI: SliderSpec[] = [
  { key: 'rate', label: 'rate', min: 1, max: 60, step: 0.5 },
];

const EFFECT_ORDER: FrameEffectName[] = ['reveal', 'ripple', 'liquid-cursor'];
const EFFECT_HINT: Record<FrameEffectName, string> = {
  reveal: 'autoplay or replay to see it',
  ripple: 'click the plate',
  'liquid-cursor': 'hover the plate',
};

function buildEffectProp(
  active: Record<FrameEffectName, boolean>,
  params: PlaygroundParams,
  rippleDurationEnabled: boolean,
  glass: boolean,
  glassColors: { rimColor: string; tintColor: string },
  morph: boolean,
): LiveGraphicProps['effect'] {
  const specs: LiveGraphicEffectSpec[] = EFFECT_ORDER
    .filter((name) => active[name])
    .map((name) => {
      if (name === 'ripple') {
        const duration = rippleDurationEnabled ? params.ripple.duration : Infinity;
        return { name, ...params.ripple, duration } as LiveGraphicEffectSpec;
      }
      return { name, ...params[name] } as LiveGraphicEffectSpec;
    });
  // Glass params ride alongside via a liquid-glass spec — extracted by
  // LiveGraphic's extractGlassSpec, then applied as glass uniforms. The
  // `material='glass'` prop is what actually activates the pipeline.
  if (glass) {
    specs.push({
      name: 'liquid-glass',
      ...params.glass,
      ...glassColors,
    } as LiveGraphicEffectSpec);
  }
  if (morph) {
    specs.push({ name: 'morph', ...params.morph } as LiveGraphicEffectSpec);
  }
  if (specs.length === 0) return 'none';
  return specs;
}

function Playground({
  src,
  bakeKey,
  onError,
}: {
  src: string;
  bakeKey: number;
  onError: (err: Error) => void;
}) {
  const [active, setActive] = useState<Record<FrameEffectName, boolean>>({
    reveal: false,
    ripple: true,
    'liquid-cursor': true,
  });
  const [glass, setGlass] = useState(false);
  const [glassRim, setGlassRim] = useState<string>(GLASS_DEFAULTS.rimColor);
  const [glassTint, setGlassTint] = useState<string>(GLASS_DEFAULTS.tintColor);
  const [glassUploadUrl, setGlassUploadUrl] = useState<string | null>(null);
  const [glassUploadName, setGlassUploadName] = useState<string | null>(null);
  const glassFileInputRef = useRef<HTMLInputElement>(null);
  const [morph, setMorph] = useState(false);
  const [morphUploadUrl, setMorphUploadUrl] = useState<string | null>(null);
  const [morphUploadName, setMorphUploadName] = useState<string | null>(null);
  const [morphToColor, setMorphToColor] = useState<string>(MORPH_DEFAULT_TO_COLOR);
  const morphFileInputRef = useRef<HTMLInputElement>(null);
  const [params, setParams] = useState<PlaygroundParams>(DEFAULT_PARAMS);
  const [rippleDurationEnabled, setRippleDurationEnabled] = useState(false);
  const [tint, setTint] = useState(true);
  const [color, setColor] = useState('#ff6a3d');

  // Tint-on by default is the right read for the demo logo (a single-path
  // silhouette where the color override is the whole point). For an
  // uploaded SVG the user is almost always there to preview their own
  // artwork, where the native per-path paint is what they want to see —
  // force tint off on upload, restore on reset to the default.
  useEffect(() => {
    setTint(src === DEFAULT_SRC);
  }, [src]);
  const [opacity, setOpacity] = useState(1);
  const [autoPlay, setAutoPlay] = useState(false);
  const logoRef = useRef<LiveGraphicHandle>(null);

  // Lazy backdrop — only built when glass is toggled on. If the user
  // uploaded an image, hand its object URL straight to LiveGraphic (it
  // accepts string URLs). Otherwise use the generated grid+gradient
  // canvas. Re-using the same value across renders keeps the renderer's
  // texture upload to a single init pass per mount.
  const glassGenerated = useMemo<HTMLCanvasElement | null>(
    () => (glass && !glassUploadUrl ? makeGlassBackdrop() : null),
    [glass, glassUploadUrl],
  );
  const glassBackdrop: string | HTMLCanvasElement | undefined = glass
    ? (glassUploadUrl ?? glassGenerated ?? undefined)
    : undefined;
  const glassBackdropCssUrl = glass
    ? (glassUploadUrl ?? glassGenerated?.toDataURL() ?? null)
    : null;

  // Release the object URL on unmount / replace so we don't leak.
  useEffect(() => () => {
    if (glassUploadUrl) URL.revokeObjectURL(glassUploadUrl);
  }, [glassUploadUrl]);

  const onGlassFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    if (glassUploadUrl) URL.revokeObjectURL(glassUploadUrl);
    setGlassUploadUrl(url);
    setGlassUploadName(file.name);
  };

  const clearGlassUpload = () => {
    if (glassUploadUrl) URL.revokeObjectURL(glassUploadUrl);
    setGlassUploadUrl(null);
    setGlassUploadName(null);
  };

  // Release the object URL when a new morph target replaces it (or on unmount).
  useEffect(() => () => {
    if (morphUploadUrl) URL.revokeObjectURL(morphUploadUrl);
  }, [morphUploadUrl]);

  const onMorphFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const looksLikeSvg =
      file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    if (!looksLikeSvg) return;
    const url = URL.createObjectURL(file);
    if (morphUploadUrl) URL.revokeObjectURL(morphUploadUrl);
    setMorphUploadUrl(url);
    setMorphUploadName(file.name);
  };

  const clearMorphUpload = () => {
    if (morphUploadUrl) URL.revokeObjectURL(morphUploadUrl);
    setMorphUploadUrl(null);
    setMorphUploadName(null);
  };

  const morphTargetSrc = morphUploadUrl ?? MORPH_DEFAULT_TO;

  const effectProp = buildEffectProp(
    active,
    params,
    rippleDurationEnabled,
    glass,
    { rimColor: glassRim, tintColor: glassTint },
    morph,
  );

  const toggleEffect = (name: FrameEffectName) => {
    setActive((a) => ({ ...a, [name]: !a[name] }));
  };

  const updateParam = <K extends FrameEffectName>(
    name: K,
    key: string,
    value: number,
  ) => {
    setParams((p) => ({ ...p, [name]: { ...p[name], [key]: value } }));
  };

  const updateGlassParam = (key: keyof GlassNumericParams, value: number) => {
    setParams((p) => ({ ...p, glass: { ...p.glass, [key]: value } }));
  };

  const updateMorphParam = (key: keyof PlaygroundParams['morph'], value: number) => {
    setParams((p) => ({ ...p, morph: { ...p.morph, [key]: value } }));
  };

  // Glass + morph compose: when both are on, the glass pipeline samples
  // the two morph-baked SDFs and blends them per fragment by the morph's
  // hover-driven `t`, so the backdrop refracts through a continuously
  // morphing silhouette. The toggles are independent.
  const toggleGlass = () => setGlass((g) => !g);
  const toggleMorph = () => setMorph((m) => !m);

  const resetParams = () => {
    setParams(DEFAULT_PARAMS);
    setGlassRim(GLASS_DEFAULTS.rimColor);
    setGlassTint(GLASS_DEFAULTS.tintColor);
    setMorphToColor(MORPH_DEFAULT_TO_COLOR);
  };

  return (
    <section className="playground" aria-label="playground">
      <header className="playground-head">
        <div>
          <span className="card-num">00</span>
          <h2>Playground</h2>
        </div>
        <p>Toggle effects, compose freely, and drag sliders to tune parameters live.</p>
      </header>

      <div className="playground-body">
        <div
          className="playground-canvas"
          style={glassBackdropCssUrl ? {
            backgroundImage: `url(${glassBackdropCssUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          } : undefined}
        >
          <LiveGraphic
            key={bakeKey}
            ref={logoRef}
            src={src}
            // Morph has no per-path paint, so an unset color renders as
            // transparent. Force the start color through whenever morph
            // is active, regardless of the tint toggle.
            color={morph || tint ? color : undefined}
            opacity={opacity}
            effect={effectProp}
            material={glass ? 'glass' : undefined}
            backdrop={glassBackdrop}
            to={morph ? morphTargetSrc : undefined}
            toFillColor={morph ? morphToColor : undefined}
            autoPlay={autoPlay}
            ariaLabel="playground logo"
            onError={onError}
            style={{ position: 'absolute', inset: 0 }}
          />
        </div>

        <div className="playground-controls">
          <div className="ctrl-group">
            <div className="ctrl-group-head">effects</div>
            <div className="effect-toggles">
              {EFFECT_ORDER.map((name) => (
                <label key={name} className="chip" data-on={active[name] ? 'true' : 'false'}>
                  <input
                    type="checkbox"
                    checked={active[name]}
                    onChange={() => toggleEffect(name)}
                  />
                  <span>{name}</span>
                </label>
              ))}
              <label className="chip" data-on={glass ? 'true' : 'false'}>
                <input
                  type="checkbox"
                  checked={glass}
                  onChange={toggleGlass}
                />
                <span>glass</span>
              </label>
              <label className="chip" data-on={morph ? 'true' : 'false'}>
                <input
                  type="checkbox"
                  checked={morph}
                  onChange={toggleMorph}
                />
                <span>morph</span>
              </label>
            </div>
            {EFFECT_ORDER.some((n) => active[n]) || glass || morph ? (
              <div className="effect-hint">
                {[
                  ...EFFECT_ORDER.filter((n) => active[n]).map((n) => EFFECT_HINT[n]),
                  ...(glass ? ['refracts the backdrop'] : []),
                  ...(morph ? ['hover to morph'] : []),
                ].join(' · ')}
              </div>
            ) : null}
          </div>

          <div className="ctrl-group">
            <div className="ctrl-group-head">appearance</div>
            <label className="row">
              <span className="row-label">tint</span>
              <input type="checkbox" checked={tint} onChange={(e) => setTint(e.target.checked)} />
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                disabled={!tint}
                aria-label="tint color"
              />
              <code className="row-val">{tint ? color : 'native'}</code>
            </label>
            <label className="row">
              <span className="row-label">opacity</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
              <code className="row-val">{opacity.toFixed(2)}</code>
            </label>
          </div>

          {active.reveal ? (
            <div className="ctrl-group">
              <div className="ctrl-group-head">
                reveal
                <span className="group-actions">
                  <label className="row inline">
                    <input
                      type="checkbox"
                      checked={autoPlay}
                      onChange={(e) => setAutoPlay(e.target.checked)}
                    />
                    <span>autoPlay</span>
                  </label>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => logoRef.current?.replay()}
                  >
                    ↺ replay
                  </button>
                </span>
              </div>
              {PARAM_UI.reveal.map((s) => (
                <ParamSlider
                  key={s.key}
                  spec={s}
                  value={params.reveal[s.key as keyof PlaygroundParams['reveal']]}
                  onChange={(v) => updateParam('reveal', s.key, v)}
                />
              ))}
            </div>
          ) : null}

          {active.ripple ? (
            <div className="ctrl-group">
              <div className="ctrl-group-head">ripple</div>
              {PARAM_UI.ripple.map((s) => {
                if (s.key === 'duration') {
                  const decimals = Math.max(0, -Math.floor(Math.log10(s.step)));
                  return (
                    <div key={s.key} className="row">
                      <span className="row-label row-label-check">
                        <input
                          type="checkbox"
                          checked={rippleDurationEnabled}
                          onChange={(e) => setRippleDurationEnabled(e.target.checked)}
                          aria-label="enable duration cap"
                        />
                        duration
                      </span>
                      <input
                        type="range"
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        value={params.ripple.duration}
                        onChange={(e) => updateParam('ripple', 'duration', Number(e.target.value))}
                        disabled={!rippleDurationEnabled}
                      />
                      <code className="row-val">
                        {rippleDurationEnabled ? params.ripple.duration.toFixed(decimals) : '—'}
                      </code>
                    </div>
                  );
                }
                return (
                  <ParamSlider
                    key={s.key}
                    spec={s}
                    value={params.ripple[s.key as keyof PlaygroundParams['ripple']]}
                    onChange={(v) => updateParam('ripple', s.key, v)}
                  />
                );
              })}
            </div>
          ) : null}

          {active['liquid-cursor'] ? (
            <div className="ctrl-group">
              <div className="ctrl-group-head">liquid-cursor</div>
              {PARAM_UI['liquid-cursor'].map((s) => (
                <ParamSlider
                  key={s.key}
                  spec={s}
                  value={params['liquid-cursor'][s.key as keyof PlaygroundParams['liquid-cursor']]}
                  onChange={(v) => updateParam('liquid-cursor', s.key, v)}
                />
              ))}
            </div>
          ) : null}

          {glass ? (
            <div className="ctrl-group">
              <div className="ctrl-group-head">
                glass
                <span className="group-actions">
                  <input
                    ref={glassFileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={onGlassFile}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => glassFileInputRef.current?.click()}
                    title={glassUploadName ?? 'use a custom backdrop image'}
                  >
                    ↑ backdrop
                  </button>
                  {glassUploadUrl ? (
                    <button type="button" className="btn" onClick={clearGlassUpload}>
                      reset
                    </button>
                  ) : null}
                </span>
              </div>
              {glassUploadName ? (
                <div className="effect-hint">{glassUploadName}</div>
              ) : null}
              {GLASS_PARAM_UI.map((s) => (
                <ParamSlider
                  key={s.key}
                  spec={s}
                  value={params.glass[s.key as keyof GlassNumericParams]}
                  onChange={(v) => updateGlassParam(s.key as keyof GlassNumericParams, v)}
                />
              ))}
              <label className="row">
                <span className="row-label">rim</span>
                <input
                  type="color"
                  value={glassRim}
                  onChange={(e) => setGlassRim(e.target.value)}
                  aria-label="rim color"
                />
                <code className="row-val">{glassRim}</code>
              </label>
              <label className="row">
                <span className="row-label">tint color</span>
                <input
                  type="color"
                  value={glassTint}
                  onChange={(e) => setGlassTint(e.target.value)}
                  aria-label="tint color"
                />
                <code className="row-val">{glassTint}</code>
              </label>
            </div>
          ) : null}

          {morph ? (
            <div className="ctrl-group">
              <div className="ctrl-group-head">
                morph
                <span className="group-actions">
                  <input
                    ref={morphFileInputRef}
                    type="file"
                    accept=".svg,image/svg+xml"
                    onChange={onMorphFile}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => morphFileInputRef.current?.click()}
                    title={morphUploadName ?? 'upload a target SVG to morph into'}
                  >
                    ↑ target
                  </button>
                  {morphUploadUrl ? (
                    <button type="button" className="btn" onClick={clearMorphUpload}>
                      reset
                    </button>
                  ) : null}
                </span>
              </div>
              <div className="effect-hint">
                {morphUploadName ?? 'morph-circle.svg'}
              </div>
              {MORPH_PARAM_UI.map((s) => (
                <ParamSlider
                  key={s.key}
                  spec={s}
                  value={params.morph[s.key as keyof PlaygroundParams['morph']]}
                  onChange={(v) => updateMorphParam(s.key as keyof PlaygroundParams['morph'], v)}
                />
              ))}
              <label className="row">
                <span className="row-label">to color</span>
                <input
                  type="color"
                  value={morphToColor}
                  onChange={(e) => setMorphToColor(e.target.value)}
                  aria-label="morph end color"
                />
                <code className="row-val">{morphToColor}</code>
              </label>
            </div>
          ) : null}

          <button type="button" className="btn playground-reset" onClick={resetParams}>
            reset params
          </button>
        </div>
      </div>
    </section>
  );
}

function ParamSlider({
  spec,
  value,
  onChange,
}: {
  spec: SliderSpec;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="row">
      <span className="row-label">{spec.label}</span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <code className="row-val">
        {spec.step >= 1 ? value.toFixed(0) : value.toFixed(Math.max(0, -Math.floor(Math.log10(spec.step))))}
      </code>
    </label>
  );
}

/* ============================= showcase cards ============================ */

function ShowcaseCard({
  spec,
  src,
  bakeKey,
  onError,
}: {
  spec: CardSpec;
  src: string;
  bakeKey: number;
  onError: (err: Error) => void;
}) {
  const ref = useRef<LiveGraphicHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [toUploadedUrl, setToUploadedUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (uploadedUrl) URL.revokeObjectURL(uploadedUrl);
  }, [uploadedUrl]);
  useEffect(() => () => {
    if (toUploadedUrl) URL.revokeObjectURL(toUploadedUrl);
  }, [toUploadedUrl]);

  // Generated backdrop is only built when there's no upload. Swapping to
  // the uploaded URL drops the generated canvas for GC.
  const generated = useMemo<HTMLCanvasElement | null>(
    () => (spec.backdrop && !uploadedUrl ? makeGlassBackdrop() : null),
    [spec.backdrop, uploadedUrl],
  );
  const backdrop: string | HTMLCanvasElement | undefined = uploadedUrl
    ?? generated
    ?? undefined;
  const cssBgUrl = uploadedUrl ?? generated?.toDataURL() ?? null;

  const surfaceStyle = cssBgUrl
    ? {
        backgroundImage: `url(${cssBgUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : undefined;

  const onUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setUploadedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  };

  const onToUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const looksLikeSvg =
      file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    if (!looksLikeSvg) return;
    const url = URL.createObjectURL(file);
    setToUploadedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  };

  const toSrc = toUploadedUrl ?? spec.to;

  return (
    <article className="card">
      <header className="card-head">
        <span className="card-title">{spec.title}</span>
        <span className="card-num">{spec.number}</span>
      </header>

      <div className="card-surface" style={surfaceStyle}>
        <LiveGraphic
          key={`${spec.id}:${bakeKey}`}
          ref={ref}
          src={src}
          // Thematic color applies only to the built-in demo logo —
          // uploaded SVGs render with their own per-path paint so users
          // can preview their artwork as authored. Morph always applies
          // its colors though: the shader has no per-path paint to fall
          // back on, so an unset color would render as transparent.
          color={spec.id === 'morph' || src === DEFAULT_SRC ? spec.color : undefined}
          to={toSrc}
          toFillColor={spec.toFillColor}
          effect={spec.effect}
          backdrop={backdrop}
          autoPlay={spec.autoPlay}
          ariaLabel={spec.title}
          onError={onError}
        />
      </div>

      <footer className="card-foot">
        <code>{spec.code}</code>
        {spec.hint ? <span className="hint">{spec.hint}</span> : null}
      </footer>

      {spec.replay ? (
        <button type="button" className="card-replay" onClick={() => ref.current?.replay()}>
          ↺ replay
        </button>
      ) : null}
      {spec.backdropUpload ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onUploadFile}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            className="card-replay"
            onClick={() => fileInputRef.current?.click()}
            title="replace the backdrop with a custom image"
          >
            ↑ backdrop
          </button>
        </>
      ) : null}
      {spec.toUpload ? (
        <>
          <input
            ref={toFileInputRef}
            type="file"
            accept=".svg,image/svg+xml"
            onChange={onToUploadFile}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            className="card-replay"
            onClick={() => toFileInputRef.current?.click()}
            title="replace the morph target with a custom SVG"
          >
            ↑ target
          </button>
        </>
      ) : null}
    </article>
  );
}

function App() {
  const [src, setSrc] = useState<string>(DEFAULT_SRC);
  const [filename, setFilename] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error' } | null>(null);
  const [bakeKey, setBakeKey] = useState(0);
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const blobUrlRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const errorFiredRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setToast({ msg, kind });
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  const acceptFile = useCallback((file: File) => {
    const looksLikeSvg =
      file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    if (!looksLikeSvg) {
      showToast(`${file.name} isn't an SVG`, 'error');
      return;
    }
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const url = URL.createObjectURL(file);
    blobUrlRef.current = url;
    errorFiredRef.current = false;
    setSrc(url);
    setFilename(file.name);
    setBakeKey((k) => k + 1);
    showToast(`baked ${file.name}`);
  }, [showToast]);

  const reset = useCallback(() => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = null;
    errorFiredRef.current = false;
    setSrc(DEFAULT_SRC);
    setFilename(null);
    setBakeKey((k) => k + 1);
  }, []);

  /* Window-level drag-and-drop. Depth counter handles nested enter/leave. */
  useEffect(() => {
    let depth = 0;
    const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const onOver = (e: DragEvent) => { if (carriesFiles(e)) e.preventDefault(); };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragActive(false);
      const file = e.dataTransfer?.files[0];
      if (file) acceptFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [acceptFile]);

  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const onLogoError = useCallback((err: Error) => {
    if (errorFiredRef.current) return;
    errorFiredRef.current = true;
    // Surface the full error (stack + any .cause / .gpuCause) to the
    // console so it's copyable; the toast only renders err.message.
    // eslint-disable-next-line no-console
    console.error('[bezier-sdf] live-graphic error:', err);
    showToast(err.message, 'error');
    if (blobUrlRef.current) reset();
  }, [showToast, reset]);

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) acceptFile(file);
    e.target.value = '';
  };

  const currentLabel = filename ?? 'logo.svg';

  return (
    <>
      <div className="page">
        <header className="intro">
          <div>
            <h1>@bezier-sdf/react <span className="v">v0.1.0</span></h1>
            <p>A gallery for <code>@bezier-sdf/react</code> — a drop-in component that bakes an SVG into a GPU signed-distance field.</p>
            <p>Drag any <code>.svg</code> onto the page to re-bake every plate below.</p>
          </div>
          <div className="upload">
            <span className="file-pill" data-custom={filename ? 'true' : 'false'} title={currentLabel}>
              <span className="dot" />
              <span className="name">{currentLabel}</span>
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".svg,image/svg+xml"
              onChange={handleFilePick}
              style={{ display: 'none' }}
            />
            <button type="button" className="btn" data-variant="accent" onClick={() => fileInputRef.current?.click()}>
              ↑ upload
            </button>
            {filename ? (
              <button type="button" className="btn" onClick={reset}>reset</button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? '☀ light' : '☾ dark'}
            </button>
          </div>
        </header>

        <Playground src={src} bakeKey={bakeKey} onError={onLogoError} />

        <section className="gallery" aria-label="effect gallery">
          {CARDS.map((spec) => (
            <ShowcaseCard key={spec.id} spec={spec} src={src} bakeKey={bakeKey} onError={onLogoError} />
          ))}
        </section>
      </div>

      <div className="drop-overlay" data-active={dragActive ? 'true' : 'false'} aria-hidden>
        drop .svg to bake
      </div>

      <div className="toast" data-visible={toast ? 'true' : 'false'} data-kind={toast?.kind ?? 'info'} role="status" aria-live="polite">
        {toast?.msg}
      </div>
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
