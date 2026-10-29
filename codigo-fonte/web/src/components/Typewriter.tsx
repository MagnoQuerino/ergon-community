import { useEffect, useState } from 'react';

/**
 * Frases que se escrevem letra a letra e se revezam (espera com cara do universo do Ergon). Com "menos movimento"
 * ligado no sistema, a frase aparece inteira.
 */
export function Typewriter({ phrases, hold = 2600, className }: { phrases: string[]; hold?: number; className?: string }) {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  const calmo = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frase = phrases[i % phrases.length] ?? '';
  useEffect(() => { setI(0); setN(0); }, [phrases.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (calmo) { const t = window.setTimeout(() => setI((x) => x + 1), hold + 1200); return () => clearTimeout(t); }
    if (n < frase.length) { const t = window.setTimeout(() => setN((x) => x + 1), 28); return () => clearTimeout(t); }
    if (phrases.length < 2) return;
    const t = window.setTimeout(() => { setI((x) => x + 1); setN(0); }, hold);
    return () => clearTimeout(t);
  }, [n, frase, calmo, hold, phrases.length]);
  return (
    <span className={`typewriter ${className ?? ''}`} aria-live="polite">
      {calmo ? frase : frase.slice(0, n)}<span className="typewriter__cursor" aria-hidden="true" />
    </span>
  );
}
