import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { BezierLogo, type BezierLogoHandle, type BezierLogoProps } from '@bezier-sdf/react';
import './styles.css';

const DEFAULT_SRC = '/logo.svg';

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
    id: 'static',
    number: '01',
    title: 'Static',
    color: '#eaeaea',
    effect: 'none',
    code: `<BezierLogo src={src} />`,
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
  {
    id: 'reveal-scroll',
    number: '06',
    title: 'Reveal · scroll',
    color: '#6af0ff',
    effect: 'reveal',
    code: `<BezierLogo effect="reveal" />`,
    hint: 'scrolls into view',
  },
  {
    id: 'native-paint',
    number: '07',
    title: 'Native SVG paint',
    effect: 'none',
    code: `<BezierLogo src={src} />`,
    hint: 'omits color — per-path fills/strokes',
  },
];

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
          </div>
        </header>

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
