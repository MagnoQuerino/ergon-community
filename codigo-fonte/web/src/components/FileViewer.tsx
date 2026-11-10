import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { size } from '../lib/files.ts';
import { previaDe } from '../lib/tarefa-tela.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { useT } from '../i18n/index.ts';

interface Preview { kind: 'text' | 'sheet' | 'inline' | 'none'; text?: string; detail?: string | null; sheets?: Array<{ name: string; rows: string[][] }> }

/**
 * "Ver" um arquivo sem sair da tarefa: um diálogo por cima. O .md aparece formatado (Markdown seguro, sem HTML), o texto
 * como texto, o .csv como tabela, a imagem e o PDF como o navegador mostra. O conteúdo vem da rota de arquivos, com o seu
 * acesso; Word, Excel e o resto só baixam (a tarefa não abre esses aqui).
 *
 * Vai num portal no fim da página: dentro do painel da tarefa (position fixed, z-index próprio) o fundo escurecido
 * ficava preso a ele, e a barra do topo e o botão da conversa apareciam por cima do diálogo.
 */
export function FileViewer({ file, onClose }: { file: { id: string; filename: string; mime: string; size: number }; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const tipo = previaDe(file.filename, file.mime);
  const url = `/api/artifacts/${file.id}/download`;
  const pv = useResource<Preview>(tipo === 'markdown' || tipo === 'texto' || tipo === 'tabela' ? `/api/artifacts/${file.id}/preview` : null, []);
  const corpo = () => {
    if (tipo === 'imagem') return <img className="fview__img" src={`${url}?inline=1`} alt={file.filename} />;
    if (tipo === 'pdf') return <iframe className="fview__pdf" src={`${url}?inline=1`} title={file.filename} />;
    if (tipo === 'baixar') return <p className="muted">{t('geral.arquivo.abreNoComputador')}</p>;
    if (pv.error) return <p className="error">{t('geral.arquivo.naoAbriu')}</p>;
    if (!pv.data) return <p className="muted">{t('geral.arquivo.abrindo')}</p>;
    if (pv.data.kind === 'sheet' && pv.data.sheets?.length) {
      return pv.data.sheets.map((s) => (
        <div key={s.name} className="md__table fview__table">
          <table>
            <thead><tr>{(s.rows[0] ?? []).map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
            <tbody>{s.rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ));
    }
    if (pv.data.kind === 'text' && pv.data.text) return tipo === 'markdown' ? <Markdown text={pv.data.text} className="fview__md" /> : <pre className="fview__text">{pv.data.text}</pre>;
    return <p className="muted">{pv.data.detail ? t('geral.arquivo.semPreviaDetalhe', { detalhe: pv.data.detail }) : t('geral.arquivo.semPrevia')}</p>;
  };
  return createPortal(
    <div className="dlg-back fview-back">
      <section ref={ref} className="dlg fview" role="dialog" aria-modal="true" aria-labelledby={`fview-${file.id}`}>
        <header className="dlg__head">
          <h3 id={`fview-${file.id}`} className="fview__name" title={file.filename}>{file.filename}</h3>
          <div className="row">
            <a className="btn btn--sm" href={url} download={file.filename}><Icon name="download" size={13} /> {t('geral.arquivo.baixar', { tamanho: size(file.size) })}</a>
            <button className="icon-btn" onClick={onClose} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button>
          </div>
        </header>
        <div className="fview__body">{corpo()}</div>
      </section>
    </div>,
    document.body,
  );
}
