import { StrictMode, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BezierLogo, type BezierLogoHandle } from '@bezier-sdf/react';

function App() {
  const revealRef = useRef<BezierLogoHandle>(null);

  return (
    <div style={{ padding: '32px 24px', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontWeight: 500, letterSpacing: -0.5 }}>@bezier-sdf/react</h1>
      <p style={{ color: '#999' }}>
        Three mounts of the same SVG: static, autoplayed reveal, and a scroll-triggered reveal far below.
      </p>

      <section style={{ marginTop: 48 }}>
        <h2 style={{ fontSize: 16, color: '#888' }}>1. Static — <code>effect="none"</code></h2>
        <div style={{ width: '100%', aspectRatio: '2 / 1', background: '#111', borderRadius: 8 }}>
          <BezierLogo src="/logo.svg" color="#ffffff" ariaLabel="static logo" />
        </div>
      </section>

      <section style={{ marginTop: 48 }}>
        <h2 style={{ fontSize: 16, color: '#888' }}>2. Autoplayed reveal — <code>effect="reveal" autoPlay</code></h2>
        <div style={{ width: '100%', aspectRatio: '2 / 1', background: '#111', borderRadius: 8 }}>
          <BezierLogo
            ref={revealRef}
            src="/logo.svg"
            color="#ff3a7a"
            effect="reveal"
            autoPlay
            ariaLabel="autoplayed reveal"
          />
        </div>
        <button
          type="button"
          onClick={() => revealRef.current?.replay()}
          style={{
            marginTop: 12, padding: '8px 14px', borderRadius: 6,
            background: '#222', color: '#eee', border: '1px solid #333', cursor: 'pointer',
          }}
        >
          replay()
        </button>
      </section>

      <div style={{ height: '120vh' }} />

      <section style={{ marginTop: 48 }}>
        <h2 style={{ fontSize: 16, color: '#888' }}>3. Scroll-triggered reveal — <code>effect="reveal"</code></h2>
        <div style={{ width: '100%', aspectRatio: '2 / 1', background: '#111', borderRadius: 8 }}>
          <BezierLogo src="/logo.svg" color="#6af0ff" effect="reveal" ariaLabel="scroll-triggered reveal" />
        </div>
      </section>

      <div style={{ height: '40vh' }} />
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
