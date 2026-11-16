import { useMemo, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { Icon } from '../components/Icon.tsx';
import { BancaLoja, Estrelas } from '../arte/Cena.tsx';
import { GuiaCriar, InstalarArquivo, Instalados, Vitrine, type PacoteInstalado, type PreviewAgent } from './PacotesPanel.tsx';
import { MinhasPublicacoes, Publicar, type Rascunho } from './LojaPublicar.tsx';
import { useT } from '../i18n/index.ts';

type Aba = 'explorar' | 'instalados' | 'publicar' | 'minhas';
const ABAS: Array<{ k: Aba; icon: string }> = [{ k: 'explorar', icon: 'store' }, { k: 'instalados', icon: 'check' }, { k: 'publicar', icon: 'send' }, { k: 'minhas', icon: 'list' }];

/**
 * A Loja, no menu da esquerda: colaborativa e grátis. Ninguém compra nem vende; qualquer pessoa publica de graça. A
 * vitrine junta os oficiais do Ergon, os modelos da comunidade e a Loja do Ergon World; Instalados desfaz; Publicar
 * monta o pacote aqui (visual, equipe ou competência) e manda para a revisão; Minhas publicações mostra as versões.
 */
export function LojaView({ agent = null }: { agent?: PreviewAgent | null }) {
  const t = useT();
  const res = useResource<PacoteInstalado[]>('/api/packages', []);
  const [aba, setAba] = useState<Aba>('explorar');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const instalados = useMemo(() => new Set((res.data ?? []).filter((p) => p.active).map((p) => p.packageId)), [res.data]);
  const mudou = () => { res.reload(); window.dispatchEvent(new Event('ergon:packages')); };
  const undo = async (p: PacoteInstalado) => {
    setBusy(true);
    try { await api.del(`/api/packages/${p.id}`); setMsg({ kind: 'ok', text: t('documentos.pacotes.msg.desfeito', { titulo: p.title }) }); mudou(); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const nomeAba: Record<Aba, string> = { explorar: t('documentos.loja.aba.explorar'), instalados: t('documentos.loja.aba.instalados'), publicar: t('documentos.loja.aba.publicar'), minhas: t('documentos.loja.aba.minhas') };
  return (
    <div className="loja-pagina">
      <section className="cena-heroi" aria-labelledby="loja-titulo">
        <Estrelas n={34} semente={3} />
        <div className="cena-heroi__txt">
          <span className="cena-heroi__selo"><Icon name="store" size={14} /> {t('documentos.loja.selo')}</span>
          <h1 id="loja-titulo" className="cena-heroi__titulo">{t('documentos.loja.titulo')}</h1>
          <p className="cena-heroi__sub">{t('documentos.loja.subtitulo')}</p>
          <ul className="cena-heroi__chips">
            <li><Icon name="check" size={14} /> {t('documentos.loja.chip.gratis')}</li>
            <li><Icon name="users" size={14} /> {t('documentos.loja.chip.todos')}</li>
            <li><Icon name="shield-check" size={14} /> {t('documentos.loja.chip.revisao')}</li>
          </ul>
        </div>
        <BancaLoja />
      </section>
      <div className="loja-abas" role="tablist" aria-label={t('documentos.loja.abas')}>
        {ABAS.map((a) => (
          <button key={a.k} role="tab" aria-selected={aba === a.k} onClick={() => { setAba(a.k); setMsg(null); }}><Icon name={a.icon} size={15} /> {nomeAba[a.k]}</button>
        ))}
      </div>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {aba === 'explorar' && (
        <Vitrine busy={busy} agent={agent} instalados={instalados} onMudou={mudou} onInstall={async (url, body, item) => {
          setMsg(null); setBusy(true);
          try { await api.post(url, body); setMsg({ kind: 'ok', text: t('documentos.pacotes.msg.aplicadoLoja', { titulo: item.title }) }); mudou(); return true; }
          catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); return false; } finally { setBusy(false); }
        }} />
      )}
      {aba === 'instalados' && (
        <div className="loja-colunas">
          <Instalados lista={res.data ?? []} busy={busy} onUndo={(p) => void undo(p)} />
          <InstalarArquivo busy={busy} setBusy={setBusy} onMsg={setMsg} onMudou={mudou} />
        </div>
      )}
      {aba === 'publicar' && (
        <div className="loja-colunas">
          <Publicar rascunho={rascunho} agent={agent} onPublicado={(m) => { setMsg({ kind: 'ok', text: m }); setRascunho(null); setAba('minhas'); }} />
          <GuiaCriar />
        </div>
      )}
      {aba === 'minhas' && <MinhasPublicacoes onNovaVersao={(r) => { setRascunho(r); setAba('publicar'); }} onPublicar={() => setAba('publicar')} />}
    </div>
  );
}
