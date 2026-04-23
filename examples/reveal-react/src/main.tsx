import { StrictMode, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BezierLogo, type BezierLogoHandle } from '@bezier-sdf/react';

function Section({
  title,
  code,
  children,
}: {
  title: string;
  code: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 48 }}>
      <h2 style={{ fontSize: 16, color: '#888', margin: '0 0 8px' }}>
        {title} — <code>{code}</code>
      </h2>
      <div style={{ width: '100%', aspectRatio: '2 / 1', background: '#111', borderRadius: 8, overflow: 'hidden' }}>
        {children}
      </div>
    </section>
  );
}

function App() {
  const revealRef = useRef<BezierLogoHandle>(null);

  return (
    <div style={{ padding: '32px 24px', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontWeight: 500, letterSpacing: -0.5 }}>@bezier-sdf/react</h1>
      <p style={{ color: '#999' }}>
        Four effect presets on the same SVG: static, reveal (autoplay and scroll-triggered), ripple (click), liquid-cursor (hover).
      </p>

      <Section title="1. Static" code={'effect="none"'}>
        <BezierLogo src="/logo.svg" color="#ffffff" ariaLabel="static logo" />
      </Section>

      <Section title="2. Autoplayed reveal" code={'effect="reveal" autoPlay'}>
        <BezierLogo
          ref={revealRef}
          src="/logo.svg"
          color="#ff3a7a"
          effect="reveal"
          autoPlay
          ariaLabel="autoplayed reveal"
        />
      </Section>
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

      <Section title="3. Ripple (click the canvas)" code={'effect="ripple"'}>
        <BezierLogo src="/logo.svg" color="#9af078" effect="ripple" ariaLabel="click to ripple" />
      </Section>

      <Section title="4. Liquid cursor (hover the canvas)" code={'effect="liquid-cursor"'}>
        <BezierLogo src="/logo.svg" color="#ffb84d" effect="liquid-cursor" ariaLabel="hover for liquid pull" />
      </Section>

      <Section title="5. Liquid cursor + ripple (hover and click/tap)" code={'effect={["liquid-cursor","ripple"]}'}>
        <BezierLogo
          src="/logo.svg"
          color="#d78aff"
          effect={['liquid-cursor', 'ripple']}
          ariaLabel="hover and click to combine liquid pull and ripple"
        />
      </Section>

      <div style={{ height: '120vh' }} />

      <Section title="6. Scroll-triggered reveal" code={'effect="reveal"'}>
        <BezierLogo src="/logo.svg" color="#6af0ff" effect="reveal" ariaLabel="scroll-triggered reveal" />
      </Section>

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
