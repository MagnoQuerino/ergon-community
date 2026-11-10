import { useMemo, useState, type ReactNode } from 'react';
import { t, tn, useIdioma, useT } from '../i18n/index.ts';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import { coordLabel, examplesOf } from '../lib/team.ts';
import type { AppState, View } from '../lib/types.ts';
import { Icon } from '../components/Icon.tsx';

/**
 * Ajuda: manuais curtos de como fazer as coisas, mais "problemas comuns e como contornar". A coordenação também
 * ajuda na conversa, mas é bom ter uma referência. Os textos usam os nomes de quem coordena e de quem revisa hoje
 * (a equipe pode ter sido renomeada ou trocada por outro tema). Título, palavras de busca e corpo de cada manual vêm
 * do dicionário na hora de mostrar: a troca de idioma redesenha e a busca procura no idioma da tela.
 */
/** coord e reviewer: quem faz hoje; ex: nomes reais de colegas para os exemplos de frases */
interface Ctx { coord: string; reviewer: string; ex: [string, string, string]; go: (v: View, hash?: string) => void }
interface Article { id: string; title: () => string; icon: string; keywords: () => string; body: (c: Ctx) => ReactNode }

const Go = ({ c, v, hash, children }: { c: Ctx; v: View; hash?: string; children: ReactNode }) => <button className="link" onClick={() => c.go(v, hash)}>{children}</button>;

/** o comando do chat: o mesmo nas duas línguas */
const CMD_PENDENCIAS = '/pendencias';
const HASH_SEGURANCA = 'configuracao?seguranca';

const ARTICLES: Article[] = [
  { id: 'inicio', title: () => t('ajuda.inicio.titulo'), icon: 'compass', keywords: () => t('ajuda.inicio.palavras'),
    body: (c) => <>
      <p>{t('ajuda.inicio.p1')}</p>
      <ol>
        <li>{tn('ajuda.inicio.passo1', {
          conecte: <b>{t('ajuda.inicio.passo1Conecte')}</b>,
          link: <Go c={c} v="conexoes">{t('ajuda.lugar.conexoesContasIa')}</Go>,
          aviso: <i>{t('geral.alerta.semIa')}</i>,
        })}</li>
        <li>{tn('ajuda.inicio.passo2', { converse: <b>{t('ajuda.inicio.passo2Converse', { nome: c.coord })}</b> })}</li>
        <li>{tn('ajuda.inicio.passo3', { ative: <b>{t('ajuda.inicio.passo3Ative')}</b>, link: <Go c={c} v="rotinas">{t('ajuda.lugar.rotinas')}</Go> })}</li>
        <li>{tn('ajuda.inicio.passo4', { ajuste: <b>{t('ajuda.inicio.passo4Ajuste')}</b> })}</li>
      </ol>
      <p>{tn('ajuda.inicio.p2', { link: <Go c={c} v="tarefas">{t('ajuda.lugar.tarefas')}</Go> })}</p>
    </> },
  { id: 'conversar', title: () => t('ajuda.conversar.titulo'), icon: 'chat', keywords: () => t('ajuda.conversar.palavras'),
    body: (c) => <>
      <p>{tn('ajuda.conversar.p1', { link: <Go c={c} v="agentes">{t('ajuda.lugar.agentes')}</Go> })}</p>
      <ul>
        <li>{tn('ajuda.conversar.i1', { coord: <b>{c.coord}</b> })}</li>
        <li>{tn('ajuda.conversar.i2', { cartao: <b>{t('ajuda.conversar.i2Cartao')}</b>, todas: <b>{t('ajuda.conversar.i2Todas')}</b> })}</li>
        <li>{t('ajuda.conversar.i3')}</li>
        <li>{tn('ajuda.conversar.i4', { tarefa: <code>{t('ajuda.conversar.i4Tarefa')}</code>, pendencias: <code>{CMD_PENDENCIAS}</code> })}</li>
      </ul>
    </> },
  { id: 'personalizar', title: () => t('ajuda.personalizar.titulo'), icon: 'users', keywords: () => t('ajuda.personalizar.palavras'),
    body: (c) => <>
      <p>{tn('ajuda.personalizar.p1', { tudo: <b>{t('ajuda.personalizar.p1Tudo')}</b>, funcao: <b>{t('ajuda.personalizar.p1Funcao')}</b> })}</p>
      <h4>{t('ajuda.personalizar.h1', { nome: c.coord })}</h4>
      <ul>
        <li>{t('ajuda.personalizar.ex1', { a: c.ex[0] })}</li>
        <li>{t('ajuda.personalizar.ex2', { b: c.ex[1] })}</li>
        <li>{t('ajuda.personalizar.ex3', { a: c.ex[0], c: c.ex[2] })}</li>
        <li>{t('ajuda.personalizar.ex4')}</li>
        <li>{t('ajuda.personalizar.ex5', { c: c.ex[2] })}</li>
        <li>{t('ajuda.personalizar.ex6')}</li>
      </ul>
      <p>{t('ajuda.personalizar.p2')}</p>
      <h4>{t('ajuda.personalizar.h2')}</h4>
      <p>{tn('ajuda.personalizar.p3', { link: <Go c={c} v="agentes">{t('ajuda.lugar.agentes')}</Go>, perfil: <b>{t('ajuda.personalizar.p3Perfil')}</b> })}</p>
      <h4>{t('ajuda.personalizar.h3')}</h4>
      <ul>
        <li>{tn('ajuda.personalizar.coord', { fixo: <b>{t('ajuda.personalizar.coordFixo', { nome: c.coord })}</b> })}</li>
        <li>{tn('ajuda.personalizar.revisao', { revisao: <b>{t('ajuda.personalizar.revisaoNome')}</b>, nome: c.reviewer })}</li>
      </ul>
      <p>{tn('ajuda.personalizar.p4', { refazer: <b>{t('ajuda.pagina.refazerEquipe')}</b> })}</p>
    </> },
  { id: 'rotinas', title: () => t('ajuda.rotinas.titulo'), icon: 'repeat', keywords: () => t('ajuda.rotinas.palavras'),
    body: (c) => <>
      <p>{tn('ajuda.rotinas.p1', { link: <Go c={c} v="rotinas">{t('ajuda.lugar.biblioteca')}</Go> })}</p>
      <ul>
        <li>{tn('ajuda.rotinas.i1', { ativar: <b>{t('ajuda.rotinas.i1Ativar')}</b>, nome: c.coord })}</li>
        <li>{tn('ajuda.rotinas.i2', { minhas: <b>{t('ajuda.rotinas.i2Minhas')}</b> })}</li>
        <li>{tn('ajuda.rotinas.i3', { historico: <b>{t('ajuda.rotinas.i3Historico')}</b> })}</li>
        <li>{tn('ajuda.rotinas.i4', { criar: <b>{t('ajuda.rotinas.i4Criar', { nome: c.coord })}</b> })}</li>
        <li>{tn('ajuda.rotinas.i5', { recomendacao: <b>{t('ajuda.rotinas.i5Recomendacao')}</b> })}</li>
      </ul>
    </> },
  { id: 'tarefas', title: () => t('ajuda.tarefas.titulo'), icon: 'tasks', keywords: () => t('ajuda.tarefas.palavras'),
    body: (c) => <>
      <ul>
        <li>{tn('ajuda.tarefas.i1', { link: <Go c={c} v="tarefas">{t('ajuda.lugar.tarefas')}</Go>, enviar: <b>{t('ajuda.tarefas.i1Enviar')}</b> })}</li>
        <li>{tn('ajuda.tarefas.i2', { prazo: <b>{t('ajuda.tarefas.i2Prazo')}</b> })}</li>
        <li>{tn('ajuda.tarefas.i3', { quadroLista: <b>{t('ajuda.tarefas.i3QuadroLista')}</b> })}</li>
        <li>{tn('ajuda.tarefas.i4', { link: <Go c={c} v="equipe">{t('ajuda.lugar.fluxos')}</Go> })}</li>
        <li>{tn('ajuda.tarefas.i5', { revisao: <b>{t('ajuda.tarefas.i5Revisao')}</b>, nome: c.reviewer })}</li>
        <li>{tn('ajuda.tarefas.i6', { andamento: <b>{t('ajuda.tarefas.i6Andamento')}</b>, link: <Go c={c} v="configuracao">{t('ajuda.lugar.configuracoes')}</Go> })}</li>
      </ul>
    </> },
  { id: 'decisoes', title: () => t('ajuda.decisoes.titulo'), icon: 'bulb', keywords: () => t('ajuda.decisoes.palavras'),
    body: () => <>
      <p>{tn('ajuda.decisoes.p1', { chip: <b>{t('ajuda.decisoes.p1Chip')}</b> })}</p>
      <p>{t('ajuda.decisoes.p2')}</p>
    </> },
  { id: 'conexoes', title: () => t('ajuda.conexoes.titulo'), icon: 'plug', keywords: () => t('ajuda.conexoes.palavras'),
    body: (c) => <>
      <ul>
        <li>{tn('ajuda.conexoes.i1', { contas: <b>{t('ajuda.conexoes.i1Contas')}</b>, nous: <b>{t('ajuda.conexoes.i1Nous')}</b> })}</li>
        <li>{tn('ajuda.conexoes.i2', { apps: <b>{t('ajuda.conexoes.i2Apps')}</b> })}</li>
        <li>{tn('ajuda.conexoes.i3', { quadros: <b>{t('ajuda.conexoes.i3Quadros')}</b> })}</li>
      </ul>
      <p>{tn('ajuda.conexoes.p', { link: <Go c={c} v="conexoes">{t('ajuda.lugar.conexoes')}</Go> })}</p>
    </> },
  { id: 'cidade', title: () => t('ajuda.cidade.titulo'), icon: 'temple', keywords: () => t('ajuda.cidade.palavras'),
    body: (c) => <>
      <p>{tn('ajuda.cidade.p1', { link: <Go c={c} v="ambiente">{t('ajuda.lugar.cidade')}</Go> })}</p>
      <ul>
        <li>{t('ajuda.cidade.i1')}</li>
        <li>{t('ajuda.cidade.i2')}</li>
        <li>{t('ajuda.cidade.i3')}</li>
      </ul>
    </> },
  { id: 'seguranca', title: () => t('ajuda.seguranca.titulo'), icon: 'shield', keywords: () => t('ajuda.seguranca.palavras'),
    body: (c) => <>
      <ul>
        <li>{tn('ajuda.seguranca.i1', { cifrados: <b>{t('ajuda.seguranca.i1Cifrados')}</b> })}</li>
        <li>{tn('ajuda.seguranca.i2', { frase: <b>{t('ajuda.seguranca.i2Frase')}</b> })}</li>
        <li>{tn('ajuda.seguranca.i3', { trava: <b>{t('ajuda.seguranca.i3Trava')}</b>, link: <Go c={c} v="configuracao" hash={HASH_SEGURANCA}>{t('ajuda.lugar.configSeguranca')}</Go> })}</li>
        <li>{tn('ajuda.seguranca.i4', { duas: <b>{t('ajuda.seguranca.i4Duas')}</b> })}</li>
        <li>{t('ajuda.seguranca.i5')}</li>
      </ul>
    </> },
  { id: 'temas', title: () => t('ajuda.temas.titulo'), icon: 'palette', keywords: () => t('ajuda.temas.palavras'),
    body: (c) => <>
      <p>{tn('ajuda.temas.p1', { forma: <b>{t('ajuda.temas.p1Forma')}</b>, nome: c.coord })}</p>
      <p>{t('ajuda.temas.p2')}</p>
      <p>{tn('ajuda.temas.p3', { link: <Go c={c} v="agentes">{t('ajuda.lugar.agentes')}</Go> })}</p>
      <p className="muted">{t('ajuda.temas.p4')}</p>
    </> },
];

const PROBLEMS: Array<{ id: string; q: () => string; a: (c: Ctx) => ReactNode; keywords: () => string }> = [
  { id: 'semIa', q: () => t('ajuda.problema.semIa.q', { aviso: t('geral.alerta.semIa') }), keywords: () => t('ajuda.problema.semIa.palavras'),
    a: (c) => tn('ajuda.problema.semIa.a', { link: <Go c={c} v="conexoes">{t('ajuda.lugar.conexoesContasIa')}</Go> }) },
  { id: 'travado', q: () => t('ajuda.problema.travado.q'), keywords: () => t('ajuda.problema.travado.palavras'),
    a: () => tn('ajuda.problema.travado.a', { cancelar: <b>{t('ajuda.problema.travado.aCancelar')}</b> }) },
  { id: 'errado', q: () => t('ajuda.problema.errado.q'), keywords: () => t('ajuda.problema.errado.palavras'),
    a: (c) => t('ajuda.problema.errado.a', { nome: c.coord }) },
  { id: 'revisao', q: () => t('ajuda.problema.revisao.q'), keywords: () => t('ajuda.problema.revisao.palavras'),
    a: () => t('ajuda.problema.revisao.a') },
  { id: 'desativei', q: () => t('ajuda.problema.desativei.q'), keywords: () => t('ajuda.problema.desativei.palavras'),
    a: (c) => tn('ajuda.problema.desativei.a', { link: <Go c={c} v="agentes">{t('ajuda.lugar.agentes')}</Go>, nome: c.coord }) },
  { id: 'proposta', q: () => t('ajuda.problema.proposta.q'), keywords: () => t('ajuda.problema.proposta.palavras'),
    a: (c) => t('ajuda.problema.proposta.a', { nome: c.coord }) },
  { id: 'rotina', q: () => t('ajuda.problema.rotina.q'), keywords: () => t('ajuda.problema.rotina.palavras'),
    a: (c) => tn('ajuda.problema.rotina.a', { link: <Go c={c} v="rotinas">{t('ajuda.lugar.rotinasHistorico')}</Go>, executar: <b>{t('ajuda.problema.rotina.aExecutar')}</b> }) },
  { id: 'trancou', q: () => t('ajuda.problema.trancou.q'), keywords: () => t('ajuda.problema.trancou.palavras'),
    a: (c) => tn('ajuda.problema.trancou.a', { link: <Go c={c} v="configuracao" hash={HASH_SEGURANCA}>{t('ajuda.lugar.configSeguranca')}</Go> }) },
  { id: 'senha', q: () => t('ajuda.problema.senha.q'), keywords: () => t('ajuda.problema.senha.palavras'),
    a: () => tn('ajuda.problema.senha.a', { esqueci: <b>{t('ajuda.problema.senha.aEsqueci')}</b> }) },
  { id: 'versao', q: () => t('ajuda.problema.versao.q', { aviso: t('geral.alerta.novaVersao') }), keywords: () => t('ajuda.problema.versao.palavras'),
    a: () => t('ajuda.problema.versao.a') },
  { id: 'recomecar', q: () => t('ajuda.problema.recomecar.q'), keywords: () => t('ajuda.problema.recomecar.palavras'),
    a: () => tn('ajuda.problema.recomecar.a', { refazer: <b>{t('ajuda.pagina.refazerEquipe')}</b> }) },
];

/** onRedo só para quem pode refazer a equipe (o proprietário do workspace) */
export function AjudaView({ state, onGo, onTour, onRedo }: { state: AppState; onGo: (v: View) => void; onTour: () => void; onRedo?: () => void }) {
  const t = useT();
  const idioma = useIdioma();
  const prefs = usePrefs();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string>(() => location.hash.match(/ajuda\?(\w+)/)?.[1] ?? 'inicio');
  const [confirmRedo, setConfirmRedo] = useState(false);
  // quem coordena, quem revisa e uns colegas para os exemplos vêm prontos do servidor (sem a equipe inteira)
  const ctx: Ctx = {
    coord: coordLabel(state.team.coordinator),
    reviewer: state.team.reviewer?.name ?? t('ajuda.pagina.semRevisor'),
    ex: examplesOf(state.team.others),
    go: (v, hash) => { if (hash) history.replaceState(null, '', `#${hash}`); onGo(v); },
  };
  const term = q.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const match = (s: string) => !term || s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').includes(term);
  // a busca procura no idioma da tela (título e palavras de busca do manual)
  const arts = useMemo(() => ARTICLES.filter((a) => match(`${a.title()} ${a.keywords()}`)), [term, idioma]); // eslint-disable-line react-hooks/exhaustive-deps
  const probs = PROBLEMS.filter((p) => match(`${p.q()} ${p.keywords()}`));
  const current = ARTICLES.find((a) => a.id === open);
  const pick = (id: string) => { setOpen(id); history.replaceState(null, '', `#ajuda?${id}`); };

  return (
    <div className="page help">
      <header className="page__head">
        <h2>{t('ajuda.titulo')}</h2>
        <p className="muted">{t('ajuda.pagina.intro', { nome: ctx.coord })}</p>
      </header>
      <div className="help__actions">
        <button className="btn" onClick={onTour}><Icon name="compass" size={15} /> {t('ajuda.pagina.refazerTour')}</button>
        <label className="check"><input type="checkbox" checked={prefs.tips} onChange={(e) => savePrefs({ tips: e.target.checked })} /> {t('ajuda.pagina.mostrarDicas')}</label>
        {prefs.dismissed.length > 0 && <button className="btn btn--ghost btn--sm" onClick={() => savePrefs({ resetTips: true, tips: true })}>{t('ajuda.pagina.trazerDicas', { n: prefs.dismissed.length })}</button>}
        <span className="help__grow" />
        {!onRedo ? null : confirmRedo ? (
          <span className="row">
            <span className="hint warn">{t('ajuda.pagina.refazerAviso')}</span>
            <button className="btn btn--sm btn--primary" onClick={() => { setConfirmRedo(false); onRedo(); }}>{t('ajuda.pagina.continuar')}</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmRedo(false)}>{t('geral.comum.cancelar')}</button>
          </span>
        ) : <button className="btn btn--ghost" onClick={() => setConfirmRedo(true)}><Icon name="users" size={15} /> {t('ajuda.pagina.refazerEquipe')}</button>}
      </div>
      <div className="help__grid">
        <nav className="help__nav" aria-label={t('ajuda.pagina.manuais')}>
          <label className="help__search"><Icon name="search" size={15} /><input type="search" placeholder={t('ajuda.pagina.buscar')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('ajuda.pagina.buscar')} /></label>
          {arts.map((a) => (
            <button key={a.id} className={`help__item ${open === a.id ? 'is-on' : ''}`} onClick={() => pick(a.id)} aria-current={open === a.id ? 'true' : undefined}>
              <Icon name={a.icon} size={16} /> {a.title()}
            </button>
          ))}
          <button className={`help__item ${open === 'problemas' ? 'is-on' : ''}`} onClick={() => pick('problemas')}><Icon name="help" size={16} /> {t('ajuda.pagina.problemas', { n: probs.length })}</button>
        </nav>
        <article className="help__body card">
          {open === 'problemas' || (!current && term) ? (
            <>
              <h3>{t('ajuda.pagina.problemasTitulo')}</h3>
              {probs.length ? probs.map((p) => (
                <details key={p.id} className="help__faq" open={!!term}>
                  <summary>{p.q()}</summary>
                  <p>{p.a(ctx)}</p>
                </details>
              )) : <p className="muted">{t('ajuda.pagina.nadaEncontrado', { nome: ctx.coord })}</p>}
            </>
          ) : current ? (
            <>
              <h3><Icon name={current.icon} size={18} /> {current.title()}</h3>
              {current.body(ctx)}
            </>
          ) : <p className="muted">{t('ajuda.pagina.escolhaManual')}</p>}
        </article>
      </div>
    </div>
  );
}
