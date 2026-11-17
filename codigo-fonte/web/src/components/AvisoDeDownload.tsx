import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { downloadsInDesktopApp, inDesktopApp } from '../lib/desktop.ts';
import { EVENTO_DOWNLOAD, EVENTO_PASTA, PEDIDO, lerAviso, lerPasta, nomeDoDownload, type AvisoDownload, type PastaDownloads } from '../lib/downloads.ts';
import { Icon } from './Icon.tsx';

const TEMPO_MS = 9000;

/**
 * O aviso depois de um download (rc.33): o nome do arquivo e a pasta. No Ergon Desktop, com "Abrir pasta" e "Mostrar
 * arquivo" (o aplicativo diz quando terminou e onde ficou). No navegador, ao clicar num download do Ergon: o nome e
 * que a pasta é a de downloads do navegador (a página não sabe qual é).
 */
export function AvisoDeDownload() {
  const t = useT();
  const [aviso, setAviso] = useState<(AvisoDownload & { navegador: boolean }) | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    const mostrar = (a: AvisoDownload & { navegador: boolean }) => {
      setAviso(a);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAviso(null), TEMPO_MS);
    };
    const doAplicativo = (e: Event) => { const a = lerAviso((e as CustomEvent).detail); if (a) mostrar({ ...a, navegador: false }); };
    // no aplicativo de antes (sem o aviso dele), nada aqui: o próprio sistema mostra o download
    const doClique = (e: MouseEvent) => {
      if (inDesktopApp()) return;
      const el = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!el) return;
      const nome = nomeDoDownload({ href: el.href, download: el.hasAttribute('download') ? el.getAttribute('download') : null, texto: el.textContent ?? '' }, location.origin);
      if (nome !== null) mostrar({ id: null, nome, pasta: null, navegador: true });
    };
    window.addEventListener(EVENTO_DOWNLOAD, doAplicativo);
    document.addEventListener('click', doClique, true);
    return () => {
      window.removeEventListener(EVENTO_DOWNLOAD, doAplicativo);
      document.removeEventListener('click', doClique, true);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);
  if (!aviso) return null;
  const pedir = (url: string) => { if (downloadsInDesktopApp()) location.href = url; };
  return (
    <div className="aviso-dl" role="status">
      <Icon name="download" size={16} />
      <div className="aviso-dl__txt">
        <b>{aviso.nome || t('geral.download.arquivo')}</b>
        <small>{aviso.navegador ? t('geral.download.noNavegador') : aviso.pasta ? t('geral.download.salvoEm', { pasta: aviso.pasta }) : t('geral.download.salvo')}</small>
      </div>
      {!aviso.navegador && aviso.id !== null && downloadsInDesktopApp() && (
        <span className="aviso-dl__acoes">
          <button type="button" className="btn btn--sm" onClick={() => pedir(PEDIDO.abrirPasta(aviso.id!))}><Icon name="folder" size={13} /> {t('geral.download.abrirPasta')}</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => pedir(PEDIDO.mostrar(aviso.id!))}>{t('geral.download.mostrarArquivo')}</button>
        </span>
      )}
      <button type="button" className="icon-btn" onClick={() => setAviso(null)} aria-label={t('geral.download.fechar')}><Icon name="x" size={13} /></button>
    </div>
  );
}

/** Configurações › Minha conta: "Pasta de downloads do Ergon" (só no aplicativo; no navegador, uma linha dizendo por quê). */
export function PastaDeDownloads() {
  const t = useT();
  const [pasta, setPasta] = useState<PastaDownloads | null>(null);
  const noApp = downloadsInDesktopApp();
  useEffect(() => {
    if (!noApp) return;
    const on = (e: Event) => { const p = lerPasta((e as CustomEvent).detail); if (p) setPasta(p); };
    window.addEventListener(EVENTO_PASTA, on);
    location.href = PEDIDO.pasta; // o aplicativo responde com o evento
    return () => window.removeEventListener(EVENTO_PASTA, on);
  }, [noApp]);
  return (
    <div className="conta__dados">
      <h4>{t('geral.download.pastaTitulo')}</h4>
      {!noApp ? <p className="muted small">{inDesktopApp() ? t('geral.download.pastaAtualizar') : t('geral.download.pastaNavegador')}</p> : (
        <>
          <p className="aviso-dl__pasta"><Icon name="folder" size={14} /> <span>{pasta?.pasta ?? '…'}</span>{pasta?.padrao && <small className="muted"> {t('geral.download.pastaPadrao')}</small>}</p>
          <div className="row">
            <button type="button" className="btn btn--sm" onClick={() => { location.href = PEDIDO.escolher; }}>{t('geral.download.escolher')}</button>
            {pasta && !pasta.padrao && <button type="button" className="btn btn--sm btn--ghost" onClick={() => { location.href = PEDIDO.padrao; }}>{t('geral.download.usarPadrao')}</button>}
          </div>
          <p className="muted small">{t('geral.download.pastaDica')}</p>
        </>
      )}
    </div>
  );
}
