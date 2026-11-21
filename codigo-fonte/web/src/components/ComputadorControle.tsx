import { useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

/**
 * Controle do computador (rc.42): o selo da barra de cima enquanto um agente usa o computador (com "Assumir o controle" e
 * "Conceder o controle"), o cartão "Ativar acesso total?" quando um agente precisa e o recurso está desligado, a
 * confirmação de uma ação (protegida, ou com "confirmar cada ação") e o único passo que falta quando o sistema não deu a
 * permissão. Tudo vem de GET /api/computador (server/src/services/computador.ts).
 */
export type ModoComputador = 'desligado' | 'cada_acao' | 'total';
export interface PedidoComputador { id: string; tipo: 'ativar' | 'confirmar'; recurso: string; agente: string; resumo: string; protegida: string | null }
export interface EstadoComputador {
  disponivel: boolean;
  aparelho: { conectado: boolean; so: string | null; permissoes: { entrada: boolean; tela: boolean; passo: string | null } | null };
  modo: ModoComputador; naoPerguntar: boolean; bloqueado: boolean; liberarTudo: boolean; administra?: boolean;
  controle: 'agente' | 'pessoa'; motivo: string | null;
  emUso: { agente: string; desde: string; resumo: string } | null;
  pedidos: PedidoComputador[];
}
export type EscolhaAtivar = 'ativar' | 'uma_vez' | 'agora_nao';

export const useComputador = () => useResource<EstadoComputador>('/api/computador', ['computador.changed']);

/** O passo único para liberar a permissão do sistema (macOS, Wayland, sem tela). */
export const PASSOS = ['macos_acessibilidade', 'macos_gravacao', 'linux_wayland', 'linux_sem_tela'] as const;

/** O selo da barra: aceso enquanto um agente usa o computador; com a pessoa no controle, verde, para conceder de volta. */
export function SeloComputador({ e, onMudou }: { e: EstadoComputador | null; onMudou: () => void }) {
  const t = useT();
  const [ocupado, setOcupado] = useState(false);
  if (!e?.disponivel || !e.aparelho.conectado) return null;
  const pessoa = e.controle === 'pessoa';
  if (!e.emUso && !pessoa) return null;
  const trocar = async () => {
    setOcupado(true);
    try { await api.post('/api/computador/controle', { pessoa: !pessoa }); onMudou(); } catch { /* o estado relido mostra como ficou */ } finally { setOcupado(false); }
  };
  return (
    <span className={`tb-computador ${pessoa ? 'tb-computador--pessoa' : ''}`} role="status">
      <span className="tb-computador__luz" aria-hidden="true" />
      <Icon name="monitor" size={16} />
      <span className="tb-computador__txt">{pessoa ? t('geral.computador.voceNoControle') : t('geral.computador.usando', { nome: e.emUso?.agente ?? 'Ergon' })}</span>
      {/* na janela estreita o botão fica com a palavra curta (a barra cabe em 390 px com o selo); o nome inteiro fica no aria-label */}
      <button className="tb-computador__btn" onClick={() => void trocar()} disabled={ocupado} aria-busy={ocupado} aria-label={pessoa ? t('geral.computador.conceder') : t('geral.computador.assumir')}>
        <span className="tb-computador__btn-longo">{pessoa ? t('geral.computador.conceder') : t('geral.computador.assumir')}</span>
        <span className="tb-computador__btn-curto">{pessoa ? t('geral.computador.concederCurto') : t('geral.computador.assumirCurto')}</span>
      </button>
    </span>
  );
}

/**
 * "Ativar acesso total?": curto e convidativo. Ativar = acesso total (as protegidas ainda pedem); Só desta vez = só este
 * trabalho; Agora não (com "Não perguntar novamente", fica desligado sem perguntar). `ajuste`: aberto pela pessoa em
 * Configurações, sem agente esperando ("Só desta vez" vira "Confirmar cada ação").
 */
export function CartaoAcessoTotal({ agente, ajuste = false, ocupado = false, onEscolha }: { agente?: string | null; ajuste?: boolean; ocupado?: boolean; onEscolha: (e: EscolhaAtivar | 'cada_acao', naoPerguntar: boolean) => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const [naoPerguntar, setNaoPerguntar] = useState(false);
  useSurface(ref, { onClose: () => onEscolha('agora_nao', false), modal: true, outside: false });
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg pc-cartao" role="alertdialog" aria-modal="true" aria-labelledby="pc-cartao-t" aria-describedby="pc-cartao-d">
        <div className="pc-cartao__arte" aria-hidden="true"><span className="pc-cartao__tela"><Icon name="monitor" size={34} /></span></div>
        <h3 id="pc-cartao-t">{t('geral.computador.ativarTitulo')}</h3>
        <p id="pc-cartao-d">{agente ? t('geral.computador.ativarTexto', { nome: agente }) : t('geral.computador.ativarTextoAjuste')}</p>
        <p className="pc-cartao__garantia"><Icon name="shield-check" size={14} /> {t('geral.computador.ativarGarantia')}</p>
        <label className="check"><input type="checkbox" checked={naoPerguntar} onChange={(x) => setNaoPerguntar(x.target.checked)} /> {t('geral.computador.naoPerguntar')}</label>
        <footer className="dlg__foot pc-cartao__acoes">
          <button type="button" className="btn btn--ghost" disabled={ocupado} onClick={() => onEscolha('agora_nao', naoPerguntar)}>{t('geral.computador.agoraNao')}</button>
          <button type="button" className="btn" disabled={ocupado} onClick={() => onEscolha(ajuste ? 'cada_acao' : 'uma_vez', naoPerguntar)}>{ajuste ? t('geral.computador.cadaAcao') : t('geral.computador.soDestaVez')}</button>
          <button type="button" className="btn btn--gold pc-cartao__ativar" data-autofocus autoFocus disabled={ocupado} aria-busy={ocupado} onClick={() => onEscolha('ativar', naoPerguntar)}>{t('geral.computador.ativar')}</button>
        </footer>
      </section>
    </div>
  );
}

/** Uma ação que pede o clique da pessoa (protegida, ou com "confirmar cada ação"). */
function ConfirmarAcao({ p, ocupado, onEscolha }: { p: PedidoComputador; ocupado: boolean; onEscolha: (permitir: boolean) => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: () => onEscolha(false), modal: true, outside: false });
  return (
    <div className="dlg-back">
      <section ref={ref} className={`dlg pc-cartao pc-cartao--acao ${p.protegida ? 'pc-cartao--protegida' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="pc-acao-t">
        <h3 id="pc-acao-t"><Icon name={p.protegida ? 'lock' : 'monitor'} size={18} /> {t('geral.computador.quer', { nome: p.agente })}</h3>
        <p className="pc-cartao__resumo">{p.resumo}</p>
        {p.protegida && <p className="muted small">{t('geral.computador.protegida')}</p>}
        <footer className="dlg__foot">
          <button type="button" className="btn btn--ghost" disabled={ocupado} onClick={() => onEscolha(false)}>{t('geral.computador.recusar')}</button>
          <button type="button" className="btn btn--gold" data-autofocus autoFocus disabled={ocupado} onClick={() => onEscolha(true)}>{t('geral.computador.permitir')}</button>
        </footer>
      </section>
    </div>
  );
}

/** O passo único quando o sistema ainda não deu a permissão (no lugar de um texto longo, um passo). */
export function PassoDaPermissao({ passo }: { passo: string }) {
  const t = useT();
  const chave = (PASSOS as readonly string[]).includes(passo) ? passo as (typeof PASSOS)[number] : null;
  if (!chave) return null;
  return (
    <div className="pc-passo" role="status">
      <Icon name="key" size={16} />
      <span><b>{t('geral.computador.passoTitulo')}</b> {t(`geral.computador.passo.${chave}`)}</span>
    </div>
  );
}

/** Os cartões por cima de qualquer tela (o primeiro pedido de cada vez) e o aviso do passo de permissão. */
export function CartoesComputador({ e, onMudou }: { e: EstadoComputador | null; onMudou: () => void }) {
  const [ocupado, setOcupado] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!e?.disponivel) return null;
  const p = e.pedidos[0];
  const responder = async (escolha: string, naoPerguntar = false) => {
    if (!p) return;
    setOcupado(true); setErr(null);
    try { await api.post(`/api/computador/pedidos/${p.id}`, { escolha, ...(naoPerguntar ? { naoPerguntar } : {}) }); onMudou(); } catch (x) { setErr(errMsg(x)); } finally { setOcupado(false); }
  };
  const passo = e.aparelho.conectado ? e.aparelho.permissoes?.passo : null;
  return (
    <>
      {p?.tipo === 'ativar' && <CartaoAcessoTotal agente={p.agente} ocupado={ocupado} onEscolha={(x, n) => void responder(x === 'cada_acao' ? 'uma_vez' : x, n)} />}
      {p?.tipo === 'confirmar' && <ConfirmarAcao p={p} ocupado={ocupado} onEscolha={(ok) => void responder(ok ? 'permitir' : 'recusar')} />}
      {passo && (e.emUso || e.pedidos.length > 0 || e.modo !== 'desligado') && <div className="pc-passo-flutuante"><PassoDaPermissao passo={passo} /></div>}
      {err && <p className="error pc-erro" role="alert">{err}</p>}
    </>
  );
}
