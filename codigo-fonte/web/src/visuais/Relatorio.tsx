// O relatório (rc.42): na conversa, o resumo e até dois mini visuais com "Abrir relatório". Abrir salva o relatório em
// Documentos como .md com os blocos (```ergon-<tipo>, a convenção do documento dos Entregáveis) e o abre no visualizador
// de documentos, por cima da conversa: ali ficam a revisão ao vivo, as versões e o PDF (não há outro visualizador aqui).
import { useState } from 'react';
import type { BlocoDe } from '../../../shared/visuais/esquema.ts';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { Icon } from '../components/Icon.tsx';
import { BlocoVisual } from './Visual.tsx';
import { DocumentoDoRelatorio, type ArquivoDoRelatorio } from './documento.tsx';

type Rel = BlocoDe<'relatorio'>;

export function RelatorioCompacto({ b }: { b: Rel }) {
  const t = useT();
  const [arq, setArq] = useState<ArquivoDoRelatorio | null>(null);
  const [aberto, setAberto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const abrir = async () => {
    if (busy) return;
    if (arq) { setAberto(true); return; }
    setBusy(true); setErro(null);
    // o servidor devolve o mesmo arquivo se este relatório (esta versão) já foi salvo
    try { const r = await api.post<ArquivoDoRelatorio>('/api/visuais/relatorio/documento', { relatorio: b }); setArq(r); setAberto(true); } catch (e) { setErro(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="vis-rel">
      <div className="vis-rel__topo">
        <span className="vis-selo vis-selo--marca"><Icon name="book" size={11} /> {t('visuais.relatorio.versao', { n: b.versao })}</span>
        <span className="vis-rel__n">{t('visuais.relatorio.secoes', { n: b.secoes.length })}</span>
      </div>
      {b.resumo && <p className="vis-rel__resumo">{b.resumo}</p>}
      {!!b.destaques?.length && <div className="vis-rel__dest">{b.destaques.map((d, i) => <BlocoVisual key={i} b={d} sub />)}</div>}
      <div className="row vis-rel__acoes">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void abrir()} aria-busy={busy} data-keep-surface><Icon name="eye" size={14} /> {t('visuais.relatorio.abrir')}</button>
        {erro && <span className="error" role="alert">{erro}</span>}
      </div>
      {aberto && arq && <DocumentoDoRelatorio arquivo={arq} onClose={() => setAberto(false)} />}
    </div>
  );
}
