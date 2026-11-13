import { useState } from 'react';
import { lerConfigMcp, valoresPreenchidos, type EntradaMcp, type TransporteMcp } from '../../../shared/mcp-config.ts';
import { api, errMsg } from '../lib/api.ts';
import { useEnvio, useEnvioPorItem } from '../lib/envio.ts';
import { useResource } from '../lib/live.ts';
import { RECURSOS, type AppConectado, type Conectores, type FerramentaApp, type TipoFerramenta } from '../lib/recursos.ts';
import { BrandLogo } from './BrandLogo.tsx';
import { Icon } from './Icon.tsx';
import { SIMPLE_ICONS } from './simple-icons.ts';
import { fmtDataHora, fmtLista, useT } from '../i18n/index.ts';

/**
 * Conexões › Conectar outro aplicativo (rc.29): um servidor MCP que a lista de aplicativos prontos não traz. Por endereço
 * (o mais comum) ou por um programa que roda no ambiente isolado da equipe; colando a configuração que o aplicativo
 * publica ou preenchendo à mão. As chaves vão direto ao cofre da equipe e não voltam à tela. Cada aplicativo mostra as
 * ferramentas que o teste encontrou, com o que cada uma faz (só consulta, muda dados, envia em seu nome), que a pessoa
 * confere e muda. Ligar, desligar e liberar a escrita usam as mesmas rotas dos aplicativos prontos.
 */
const APPS = `${RECURSOS}/apps-proprios`;
const CABECALHO = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
const VARIAVEL = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const VALOR = /^[\x20-\x7e]+$/;
const TIPOS: readonly TipoFerramenta[] = ['leitura', 'escrita', 'envio'];
type Msg = { kind: 'ok' | 'error'; text: string } | null;
interface Chave { nome: string; valor: string; falta?: boolean }
interface Rascunho { app: string; apelido: string; icone: string; transporte: TransporteMcp; endereco: string; comando: string; argumentos: string; chaves: Chave[] }
const CABECALHO_PADRAO = 'Authorization'; // i18n-ok: o nome do cabeçalho de acesso, igual em todo idioma
const VAZIO: Rascunho = { app: '', apelido: '', icone: '', transporte: 'http', endereco: '', comando: '', argumentos: '', chaves: [{ nome: CABECALHO_PADRAO, valor: '' }] };
const MARCAS = Object.keys(SIMPLE_ICONS).sort();

function deEntrada(e: EntradaMcp): Rascunho {
  const mapa = e.transporte === 'stdio' ? e.variaveis : e.cabecalhos;
  const chaves = Object.entries(mapa).map(([nome, valor]) => ({ nome, valor, falta: e.faltam.includes(nome) }));
  const marca = e.app.toLowerCase().replace(/[^a-z0-9]/g, '');
  return { app: e.app, apelido: '', icone: SIMPLE_ICONS[marca] ? marca : '', transporte: e.transporte, endereco: e.endereco ?? '', comando: e.comando ?? '',
    argumentos: (e.argumentos ?? []).join('\n'), chaves };
}

export function OutroAplicativo({ dono }: { dono: boolean }) {
  const t = useT();
  const lista = useResource<{ apps: AppConectado[] }>(APPS, ['agents.changed']);
  const cx = useResource<Conectores>(`${RECURSOS}/conectores`, ['agents.changed']);
  const [aberto, setAberto] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [destaque, setDestaque] = useState<string | null>(null);
  const ligados = new Map((cx.data?.servidores ?? []).map((s) => [s.nome, s.ligado]));
  const escrita = new Set(cx.data?.escrita ?? []);
  const recarregar = () => { lista.reload(); cx.reload(); };
  return (
    <section className="conn-group app-outro" id="conn-outro">
      <h3>{t('conexoes.outro.titulo')}</h3>
      <p className="muted small">{t('conexoes.outro.texto')}</p>
      <p className="hint app-outro__oque"><Icon name="help" size={12} /> {t('conexoes.outro.oQueE')}</p>
      <p className="hint"><Icon name="lock" size={12} /> {t('conexoes.outro.trava')}</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {!dono ? <p className="muted small">{t('conexoes.outro.soDono')}</p>
        : aberto ? (
          <Formulario onFechar={() => setAberto(false)} onFeito={(r) => {
            setAberto(false); setDestaque(r.app.nome); recarregar();
            setMsg(r.teste?.ok ? { kind: 'ok', text: t('conexoes.outro.feito.ok', { n: r.teste.ferramentas.length }) }
              : { kind: 'error', text: t('conexoes.outro.feito.semTeste', { erro: r.teste?.erro || r.app.erro || '—' }) });
          }} />
        ) : <button className="btn btn--primary btn--sm" onClick={() => { setMsg(null); setAberto(true); }}><Icon name="plus" size={12} /> {t('conexoes.outro.abrir')}</button>}
      {!lista.data ? <p className="muted small">{lista.error ?? t('conexoes.outro.lendo')}</p>
        : !lista.data.apps.length ? (!aberto && <p className="muted small">{t('conexoes.outro.nenhum')}</p>) : (
          <ul className="plain app-outro__lista">
            {lista.data.apps.map((a) => (
              <li key={a.nome}>
                <CartaoApp a={a} dono={dono} ligado={ligados.get(a.nome) ?? true} escrita={escrita.has(a.nome)} aberto={destaque === a.nome}
                  variasContas={contasNoApp(lista.data!.apps, a) > 1}
                  onAbrir={(v) => setDestaque(v ? a.nome : null)} onMudou={recarregar} onMsg={setMsg} />
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function Formulario({ onFechar, onFeito }: { onFechar: () => void; onFeito: (r: { app: AppConectado; teste: { ok: boolean; erro: string; ferramentas: FerramentaApp[] } | null }) => void }) {
  const t = useT();
  const { indo, enviar } = useEnvio();
  const [modo, setModo] = useState<'colar' | 'mao'>('colar');
  const [colado, setColado] = useState('');
  const [entradas, setEntradas] = useState<EntradaMcp[]>([]);
  const [r, setR] = useState<Rascunho>(VAZIO);
  const [preenchido, setPreenchido] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const programa = r.transporte === 'stdio';
  const mudar = (p: Partial<Rascunho>) => setR((x) => ({ ...x, ...p }));
  const mudarChave = (i: number, p: Partial<Chave>) => setR((x) => ({ ...x, chaves: x.chaves.map((c, j) => (j === i ? { ...c, ...p, falta: false } : c)) }));
  // uma referência ($) no endereço ou nos argumentos seria trocada pela chave de outra conexão: não preenche, diz o que fazer
  const usar = (e: EntradaMcp) => { if (e.referencia) { setErro(t('conexoes.outro.colar.erroReferencia')); setEntradas([]); return; } setR(deEntrada(e)); setPreenchido(true); setModo('mao'); setErro(null); };
  const ler = () => {
    const l = lerConfigMcp(colado);
    if (!l.ok) { setErro(l.erro === 'json' ? t('conexoes.outro.colar.erroJson') : l.erro === 'vazio' ? t('conexoes.outro.colar.erroVazio') : t('conexoes.outro.colar.erroFormato')); setEntradas([]); return; }
    setErro(null);
    if (l.entradas.length === 1) usar(l.entradas[0]); else setEntradas(l.entradas);
  };
  /** A mesma conferência do servidor, antes de mandar: a mensagem sai no idioma da tela. */
  const conferir = (): string | null => {
    if (!r.app.trim()) return t('conexoes.outro.erro.app');
    if (programa ? r.argumentos.includes('$') : r.endereco.includes('$')) return t('conexoes.outro.erro.referencia');
    if (programa ? !/^[A-Za-z0-9_./@+-]{1,200}$/.test(r.comando.trim()) : !/^https?:\/\/\S{3,}$/i.test(r.endereco.trim())) return programa ? t('conexoes.outro.erro.programa') : t('conexoes.outro.erro.endereco');
    for (const c of r.chaves.filter((x) => x.nome.trim() || x.valor.trim())) {
      if (!(programa ? VARIAVEL : CABECALHO).test(c.nome.trim())) return t('conexoes.outro.erro.chaveNome', { nome: c.nome.trim() });
      if (!VALOR.test(c.valor.trim())) return t('conexoes.outro.erro.chaveValor', { nome: c.nome.trim() });
    }
    return null;
  };
  const conectar = () => void enviar('conectar', async () => {
    const e = conferir();
    if (e) { setErro(e); return; }
    setErro(null);
    const chaves = Object.fromEntries(r.chaves.filter((c) => c.nome.trim() && c.valor.trim()).map((c) => [c.nome.trim(), c.valor.trim()]));
    const corpo = {
      app: r.app.trim(), ...(r.apelido.trim() ? { apelido: r.apelido.trim() } : {}), ...(r.icone ? { icone: r.icone } : {}), transporte: r.transporte,
      ...(programa
        ? { comando: r.comando.trim(), argumentos: r.argumentos.split('\n').map((x) => x.trim()).filter(Boolean), ...(Object.keys(chaves).length ? { variaveis: chaves } : {}) }
        : { endereco: r.endereco.trim(), ...(Object.keys(chaves).length ? { cabecalhos: chaves } : {}) }),
    };
    try { onFeito(await api.post(APPS, corpo)); } catch (x) { setErro(errMsg(x)); }
  });
  return (
    <div className="card card--inset app-outro__form">
      <div className="row row--wrap app-outro__modos" role="tablist">
        <button role="tab" aria-selected={modo === 'colar'} className={`chip ${modo === 'colar' ? 'chip--on' : ''}`} onClick={() => setModo('colar')}>{t('conexoes.outro.modo.colar')}</button>
        <button role="tab" aria-selected={modo === 'mao'} className={`chip ${modo === 'mao' ? 'chip--on' : ''}`} onClick={() => setModo('mao')}>{t('conexoes.outro.modo.mao')}</button>
        <button className="btn btn--ghost btn--sm app-outro__fechar" onClick={onFechar}><Icon name="x" size={12} /> {t('conexoes.outro.fechar')}</button>
      </div>
      {modo === 'colar' ? (
        <div>
          <label className="field">{t('conexoes.outro.colar.rotulo')}
            <textarea rows={7} spellCheck={false} className="app-outro__codigo" value={colado} onChange={(e) => setColado(e.target.value)} />
          </label>
          <p className="muted small">{t('conexoes.outro.colar.dica')}</p>
          {entradas.length > 1 && (
            <div>
              <p className="small">{t('conexoes.outro.colar.varios', { n: entradas.length })}</p>
              <div className="row row--wrap">{entradas.map((e, i) => <button key={`${e.app}-${i}`} className="chip" onClick={() => usar(e)}>{e.app}</button>)}</div>
            </div>
          )}
          {erro && <p className="error" role="alert">{erro}</p>}
          <button className="btn btn--primary btn--sm" onClick={ler}>{t('conexoes.outro.colar.ler')}</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); conectar(); }}>
          {preenchido && <p className="hint">{t('conexoes.outro.colar.preenchido')}</p>}
          <div className="app-outro__topo">
            <BrandLogo kind={r.icone || `app-proprio:${r.app}`} name={r.app || '?'} size={44} />
            <label className="field">{t('conexoes.outro.campo.app')}
              <input value={r.app} maxLength={60} onChange={(e) => mudar({ app: e.target.value })} />
              <small>{t('conexoes.outro.campo.appDica')}</small>
            </label>
            <label className="field">{t('conexoes.outro.campo.apelido')}
              <input value={r.apelido} maxLength={40} onChange={(e) => mudar({ apelido: e.target.value })} />
              <small>{t('conexoes.outro.campo.apelidoDica')}</small>
            </label>
            <label className="field">{t('conexoes.outro.campo.icone')}
              <input value={r.icone} list="app-outro-marcas" maxLength={40} onChange={(e) => mudar({ icone: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
              <datalist id="app-outro-marcas">{MARCAS.map((m) => <option key={m} value={m}>{SIMPLE_ICONS[m].title}</option>)}</datalist>
              <small>{t('conexoes.outro.campo.iconeDica')}</small>
            </label>
          </div>
          <fieldset className="app-outro__como">
            <legend>{t('conexoes.outro.campo.como')}</legend>
            <label className="check"><input type="radio" name="app-outro-como" checked={!programa} onChange={() => mudar({ transporte: 'http', chaves: r.chaves.length ? r.chaves : [{ nome: CABECALHO_PADRAO, valor: '' }] })} /> {t('conexoes.outro.como.endereco')}</label>
            <label className="check"><input type="radio" name="app-outro-como" checked={programa} onChange={() => mudar({ transporte: 'stdio', chaves: r.chaves.filter((c) => VARIAVEL.test(c.nome)) })} /> {t('conexoes.outro.como.programa')}</label>
          </fieldset>
          {programa ? (
            <>
              <p className="muted small"><Icon name="shield" size={12} /> {t('conexoes.outro.como.programaDica')}</p>
              <label className="field">{t('conexoes.outro.campo.programa')}
                <input value={r.comando} placeholder={t('conexoes.outro.campo.programaExemplo')} spellCheck={false} onChange={(e) => mudar({ comando: e.target.value })} />
              </label>
              <label className="field">{t('conexoes.outro.campo.argumentos')}
                <textarea rows={3} spellCheck={false} className="app-outro__codigo" value={r.argumentos} onChange={(e) => mudar({ argumentos: e.target.value })} />
                <small>{t('conexoes.outro.campo.argumentosDica')}</small>
              </label>
            </>
          ) : (
            <div className="row row--wrap">
              <label className="field">{t('conexoes.outro.campo.endereco')}
                <input type="url" value={r.endereco} placeholder={t('conexoes.outro.campo.enderecoExemplo')} spellCheck={false} onChange={(e) => mudar({ endereco: e.target.value })} />
              </label>
              <label className="field field--inline app-outro__forma">{t('conexoes.outro.campo.forma')}
                <select value={r.transporte} onChange={(e) => mudar({ transporte: e.target.value as TransporteMcp })}>
                  <option value="http">{t('conexoes.outro.forma.http')}</option>
                  <option value="sse">{t('conexoes.outro.forma.sse')}</option>
                </select>
              </label>
            </div>
          )}
          <fieldset className="app-outro__chaves">
            <legend>{programa ? t('conexoes.outro.chaves.variaveis') : t('conexoes.outro.chaves.cabecalhos')}</legend>
            <p className="muted small">{programa ? t('conexoes.outro.chaves.variaveisDica') : t('conexoes.outro.chaves.cabecalhosDica')}</p>
            {r.chaves.map((c, i) => (
              <div className="row app-outro__chave" key={i}>
                <input aria-label={t('conexoes.outro.chaves.nome')} placeholder={t('conexoes.outro.chaves.nome')} value={c.nome} spellCheck={false} onChange={(e) => mudarChave(i, { nome: e.target.value })} />
                <input aria-label={t('conexoes.outro.chaves.valor')} placeholder={c.falta ? t('conexoes.outro.chaves.falta') : t('conexoes.outro.chaves.valor')} className={c.falta ? 'app-outro__falta' : ''}
                  type="password" autoComplete="off" value={c.valor} onChange={(e) => mudarChave(i, { valor: e.target.value })} />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => mudar({ chaves: r.chaves.filter((_, j) => j !== i) })} aria-label={t('conexoes.outro.chaves.tirar')}><Icon name="x" size={12} /></button>
              </div>
            ))}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => mudar({ chaves: [...r.chaves, { nome: '', valor: '' }] })}><Icon name="plus" size={12} /> {t('conexoes.outro.chaves.mais')}</button>
            <p className="hint"><Icon name="key" size={12} /> {t('conexoes.outro.chaves.cofre')}</p>
          </fieldset>
          {erro && <p className="error" role="alert">{erro}</p>}
          <button className="btn btn--primary" type="submit" aria-busy={indo === 'conectar'}>{indo === 'conectar' ? t('conexoes.outro.conectando') : t('conexoes.outro.conectar')}</button>
        </form>
      )}
    </div>
  );
}

/** Quantas contas o aplicativo deste cartão tem (o mesmo aplicativo conectado com outra conta: modelo das Conexões). */
const contasNoApp = (apps: readonly AppConectado[], a: AppConectado): number =>
  apps.filter((x) => x.app.trim().toLowerCase() === a.app.trim().toLowerCase()).length;

function CartaoApp({ a, dono, ligado, escrita, aberto, variasContas, onAbrir, onMudou, onMsg }: {
  a: AppConectado; dono: boolean; ligado: boolean; escrita: boolean; aberto: boolean; variasContas: boolean;
  onAbrir: (v: boolean) => void; onMudou: () => void; onMsg: (m: Msg) => void;
}) {
  const t = useT();
  const { vai, enviar } = useEnvioPorItem();
  const [filtro, setFiltro] = useState('');
  const [trocar, setTrocar] = useState<Record<string, string> | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const fazer = (acao: string, f: () => Promise<unknown>, ok?: string) => void enviar(a.nome, acao, async () => {
    try { await f(); if (ok) onMsg({ kind: 'ok', text: ok }); onMudou(); } catch (x) { onMsg({ kind: 'error', text: errMsg(x) }); }
  });
  const estado = !ligado ? t('conexoes.outro.app.estadoDesligado') : escrita ? t('conexoes.outro.app.estadoEscrita') : t('conexoes.outro.app.estadoConsulta');
  const termo = filtro.trim().toLowerCase();
  const ferramentas = a.ferramentas.filter((f) => !termo || f.nome.toLowerCase().includes(termo) || f.descricao.toLowerCase().includes(termo));
  const nomeTipo = (x: TipoFerramenta) => t(x === 'leitura' ? 'conexoes.outro.tipo.leitura' : x === 'envio' ? 'conexoes.outro.tipo.envio' : 'conexoes.outro.tipo.escrita');
  return (
    <div className={`app-outro__app ${aberto ? 'app-outro__app--on' : ''}`}>
      <button className="app-outro__cab" onClick={() => onAbrir(!aberto)} aria-expanded={aberto}>
        <BrandLogo kind={a.icone || `app-proprio:${a.nome}`} name={a.app} size={36} />
        <span className="app-outro__nome"><b>{a.app}{a.apelido ? ` · ${a.apelido}` : ''}</b>
          <span className="row row--wrap app-outro__selos"><span className={`badge ${ligado ? 'badge--ok' : ''}`}>{estado}</span>
            {variasContas && a.principal && <span className="badge">{t('conexoes.multi.principal')}</span>}</span></span>
        <Icon name={aberto ? 'chevron-up' : 'chevron'} size={14} />
      </button>
      {aberto && (
        <div className="app-outro__corpo">
          <p className="muted small app-outro__onde">{a.transporte === 'stdio' ? t('conexoes.outro.app.programa', { comando: [a.comando ?? '', ...a.argumentos].join(' ') }) : t('conexoes.outro.app.endereco', { endereco: a.endereco ?? '' })}</p>
          <p className="muted small">{a.chaves.length ? t('conexoes.outro.app.chaves', { lista: fmtLista(a.chaves.map((c) => c.nome)) }) : t('conexoes.outro.app.semChaves')}</p>
          <p className="muted small">{a.testadoEm ? t('conexoes.outro.app.testado', { quando: fmtDataHora(a.testadoEm) }) : t('conexoes.outro.app.nuncaTestado')}</p>
          {a.erro && <p className="warn small">{t('conexoes.outro.app.erro', { erro: a.erro })}</p>}
          {dono && (
            <div className="row row--wrap app-outro__acoes">
              <button className="btn btn--sm" aria-busy={vai(a.nome, 'testar')} onClick={() => fazer('testar', async () => {
                const r = await api.post<{ teste: { ok: boolean; ferramentas: FerramentaApp[]; erro: string } }>(`${APPS}/${a.nome}/testar`);
                if (!r.teste.ok) throw new Error(t('conexoes.outro.app.erro', { erro: r.teste.erro }));
                onMsg({ kind: 'ok', text: t('conexoes.outro.app.testeOk', { n: r.teste.ferramentas.length }) });
              }, undefined)}><Icon name="repeat" size={12} /> {vai(a.nome, 'testar') ? t('conexoes.outro.app.testando') : t('conexoes.outro.app.testar')}</button>
              <label className="check"><input type="checkbox" checked={ligado} onChange={(e) => fazer('ligar', () => api.put(`${RECURSOS}/conectores/${a.nome}`, { ligado: e.target.checked }))} /> {t('conexoes.outro.app.ligar')}</label>
              <label className="check"><input type="checkbox" checked={escrita} onChange={(e) => fazer('escrita', () => api.put(`${RECURSOS}/conectores/${a.nome}/escrita`, { liberada: e.target.checked }))} />
                <span>{t('conexoes.outro.app.escrita')} <small className="muted">{t('conexoes.outro.app.escritaDica')}</small></span></label>
              {variasContas && !a.principal && <button className="btn btn--ghost btn--sm" aria-busy={vai(a.nome, 'principal')}
                onClick={() => fazer('principal', () => api.patch(`${APPS}/${a.nome}`, { principal: true }))}>{t('conexoes.multi.tornarPrincipal')}</button>}
              {a.chaves.length > 0 && <button className="btn btn--ghost btn--sm" onClick={() => setTrocar(trocar ? null : {})}><Icon name="key" size={12} /> {t('conexoes.outro.app.trocarChave')}</button>}
              {!confirmar ? <button className="btn btn--ghost btn--sm" onClick={() => setConfirmar(true)}><Icon name="trash" size={12} /> {t('conexoes.outro.app.remover')}</button> : (
                <>
                  <button className="btn btn--sm btn--danger" aria-busy={vai(a.nome, 'remover')} onClick={() => fazer('remover', () => api.del(`${APPS}/${a.nome}`), t('conexoes.outro.app.removido'))}>
                    {vai(a.nome, 'remover') ? t('conexoes.outro.app.removendo') : t('conexoes.outro.app.removerConfirmar')}</button>
                  <button className="btn btn--ghost btn--sm" onClick={() => setConfirmar(false)}>{t('conexoes.outro.app.cancelar')}</button>
                </>
              )}
            </div>
          )}
          {dono && trocar && (
            <form className="app-outro__trocar" onSubmit={(e) => { e.preventDefault(); fazer('chaves', async () => {
              const valores = valoresPreenchidos(trocar);
              // nada preenchido: diz na tela, sem mandar (o pedido vazio seria recusado com uma mensagem técnica)
              if (!Object.keys(valores).length) throw new Error(t('conexoes.outro.app.trocarVazio'));
              await api.put(`${APPS}/${a.nome}/chaves`, { valores });
              setTrocar(null);
            }, t('conexoes.outro.app.trocada')); }}>
              {a.chaves.map((c) => (
                <label key={c.nome} className="field">{c.nome}
                  <input type="password" autoComplete="off" value={trocar[c.nome] ?? ''} onChange={(e) => setTrocar({ ...trocar, [c.nome]: e.target.value })} />
                </label>
              ))}
              <button className="btn btn--primary btn--sm" type="submit" aria-busy={vai(a.nome, 'chaves')}>{vai(a.nome, 'chaves') ? t('conexoes.outro.app.trocando') : t('conexoes.outro.app.trocarSalvar')}</button>
            </form>
          )}
          <h4 className="app-outro__ferr-titulo">{t('conexoes.outro.app.ferramentas', { n: a.ferramentas.length })}</h4>
          {!a.ferramentas.length ? <p className="muted small">{t('conexoes.outro.app.semFerramentas')}</p> : (
            <>
              <p className="muted small">{t('conexoes.outro.app.ferramentasDica')}</p>
              {a.ferramentas.length > 8 && <input className="conn-search" value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder={t('conexoes.outro.app.filtrar')} aria-label={t('conexoes.outro.app.filtrar')} />}
              <ul className="plain app-outro__ferramentas">
                {ferramentas.map((f) => (
                  <li key={f.nome} className={`app-outro__ferr app-outro__ferr--${f.tipo}`}>
                    <span className="app-outro__ferr-txt"><code>{f.nome}</code>{f.descricao && <small className="muted"> {f.descricao}</small>}</span>
                    {dono ? (
                      <span className="app-outro__ferr-tipo">
                        <select aria-label={t('conexoes.outro.tipo.rotulo', { nome: f.nome })} value={f.tipo}
                          onChange={(e) => fazer(`tipo:${f.nome}`, () => api.put(`${APPS}/${a.nome}/ferramentas`, { ferramenta: f.nome, tipo: e.target.value }))}>
                          {TIPOS.map((x) => <option key={x} value={x}>{nomeTipo(x)}</option>)}
                        </select>
                        {f.tipo !== f.sugerido && <small className="muted">{t('conexoes.outro.tipo.sugestao', { tipo: nomeTipo(f.sugerido) })}</small>}
                      </span>
                    ) : <span className="badge">{nomeTipo(f.tipo)}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

