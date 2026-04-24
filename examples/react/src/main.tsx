import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BezierLogo,
  type BezierLogoEffectName,
  type BezierLogoEffectSpec,
  type BezierLogoHandle,
  type BezierLogoProps,
} from '@bezier-sdf/react';
import './styles.css';

// The gallery's tunable effects are the frame-based ones. `liquid-glass`
// is a material with its own demo (examples/liquid-glass), so it's
// excluded from the playground type to keep record shapes closed.
type FrameEffectName = Exclude<BezierLogoEffectName, 'liquid-glass'>;

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
  effect: BezierLogoProps['effect'];
  autoPlay?: boolean;
  code: string;
  hint?: string;
  replay?: boolean;
}

const CARDS: CardSpec[] = [
  {
    id: 'native-paint',
    number: '01',
    title: 'Native SVG paint',
    effect: 'none',
    code: `<BezierLogo src={src} />`,
    hint: 'per-path fills/strokes',
  },
  {
    id: 'reveal-auto',
    number: '02',
    title: 'Reveal · autoplay',
    color: '#ff3a7a',
    effect: 'reveal',
    autoPlay: true,
    code: `<BezierLogo effect="reveal" autoPlay />`,
    replay: true,
  },
  {
    id: 'ripple',
    number: '03',
    title: 'Ripple',
    color: '#9af078',
    effect: 'ripple',
    code: `<BezierLogo effect="ripple" />`,
    hint: 'click the plate',
  },
  {
    id: 'liquid',
    number: '04',
    title: 'Liquid cursor',
    color: '#ffb84d',
    effect: 'liquid-cursor',
    code: `<BezierLogo effect="liquid-cursor" />`,
    hint: 'hover the plate',
  },
  {
    id: 'combo',
    number: '05',
    title: 'Liquid cursor + ripple',
    color: '#d78aff',
    effect: ['liquid-cursor', 'ripple'],
    code: `<BezierLogo effect={['liquid-cursor','ripple']} />`,
    hint: 'hover, then click',
  },
];

/* ============================== playground ============================== */

type PlaygroundParams = {
  reveal: { duration: number; startOffset: number; sminK: number };
  ripple: { speed: number; duration: number; amplitude: number; decay: number };
  'liquid-cursor': { pull: number; radius: number; lerp: number };
};

const DEFAULT_PARAMS: PlaygroundParams = {
  reveal: { duration: 1400, startOffset: 0.3, sminK: 0.08 },
  ripple: { speed: 2.8, duration: 0.9, amplitude: 0.08, decay: 3.5 },
  'liquid-cursor': { pull: 0.08, radius: 0.15, lerp: 0.5 },
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
): BezierLogoProps['effect'] {
  const specs: BezierLogoEffectSpec[] = EFFECT_ORDER
    .filter((name) => active[name])
    .map((name) => {
      if (name === 'ripple') {
        const duration = rippleDurationEnabled ? params.ripple.duration : Infinity;
        return { name, ...params.ripple, duration } as BezierLogoEffectSpec;
      }
      return { name, ...params[name] } as BezierLogoEffectSpec;
    });
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
  const [params, setParams] = useState<PlaygroundParams>(DEFAULT_PARAMS);
  const [rippleDurationEnabled, setRippleDurationEnabled] = useState(false);
  const [tint, setTint] = useState(true);
  const [color, setColor] = useState('#ff6a3d');
  const [opacity, setOpacity] = useState(1);
  const [autoPlay, setAutoPlay] = useState(false);
  const logoRef = useRef<BezierLogoHandle>(null);

  const effectProp = buildEffectProp(active, params, rippleDurationEnabled);

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

  const resetParams = () => setParams(DEFAULT_PARAMS);

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
        <div className="playground-canvas">
          <BezierLogo
            key={bakeKey}
            ref={logoRef}
            src={src}
            color={tint ? color : undefined}
            opacity={opacity}
            effect={effectProp}
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
            </div>
            {EFFECT_ORDER.some((n) => active[n]) ? (
              <div className="effect-hint">
                {EFFECT_ORDER.filter((n) => active[n]).map((n) => EFFECT_HINT[n]).join(' · ')}
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
  const ref = useRef<BezierLogoHandle>(null);

  return (
    <article className="card">
      <header className="card-head">
        <span className="card-title">{spec.title}</span>
        <span className="card-num">{spec.number}</span>
      </header>

      <div className="card-surface">
        <BezierLogo
          key={`${spec.id}:${bakeKey}`}
          ref={ref}
          src={src}
          color={spec.color}
          effect={spec.effect}
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
