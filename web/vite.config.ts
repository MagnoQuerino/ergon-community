import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { splashHtml } from './src/brand/logo.ts';

// versão única (package.json da raiz) gravada na interface: uma aba antiga percebe quando o servidor foi atualizado
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Marca no index.html: a tela de carregamento (emblema em movimento) já vem no HTML, com o CSS da animação
 * embutido, e aparece antes de o app carregar; o React a substitui pela mesma tela, que continua a animação.
 */
function brand(): Plugin {
  const css = () => readFileSync(new URL('./src/brand/brand.css', import.meta.url), 'utf8');
  return {
    name: 'ergon-brand',
    transformIndexHtml: (html) => html
      .replace('<!--ergon:brand-css-->', `<style>${css()}</style>`)
      .replace('<!--ergon:splash-->', splashHtml()),
  };
}

export default defineConfig({
  plugins: [react(), brand()],
  define: { __ERGON_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1000 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
});
