/**
 * Os campos próprios de um quadro da pessoa (rc.41), dentro de "Organizar o quadro": criar (nome e tipo), renomear,
 * escolher se aparece no cartão, reordenar, apagar e, na lista de opções e nas etiquetas, cuidar das opções (nome e cor
 * de uma paleta fixa, nas cores do tema). Num quadro espelhado os campos ficam só no Ergon. O servidor confere tudo
 * (services/campos.ts): a tela só mostra o que ele responde.
 */
import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useT } from '../i18n/index.ts';
import { PALETA, corDaPaleta } from '../lib/cartao-tela.ts';
import type { CampoQuadro, OpcaoCampo, TipoCampo } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

const TIPOS: TipoCampo[] = ['text', 'number', 'date', 'select', 'labels', 'person'];
const TIPO_ROTULO = { text: 'quadro.campos.tipo.text', number: 'quadro.campos.tipo.number', date: 'quadro.campos.tipo.date', select: 'quadro.campos.tipo.select', labels: 'quadro.campos.tipo.labels', person: 'quadro.campos.tipo.person' } as const;
const COR_ROTULO = { neutro: 'quadro.campos.cor.neutro', info: 'quadro.campos.cor.info', agua: 'quadro.campos.cor.agua', sucesso: 'quadro.campos.cor.sucesso', atencao: 'quadro.campos.cor.atencao',
  urgente: 'quadro.campos.cor.urgente', perigo: 'quadro.campos.cor.perigo', marca: 'quadro.campos.cor.marca', dourado: 'quadro.campos.cor.dourado' } as const;
const temOpcoes = (t: TipoCampo) => t === 'select' || t === 'labels';
/** quantos campos (fora as etiquetas) cabem no cartão: o servidor recusa o terceiro */
const NO_CARTAO_MAX = 2;

/** As opções de um campo: nome, cor (a paleta abre ao clicar na cor), tirar e acrescentar. Cada mudança salva a lista inteira. */
function Opcoes({ campo, busy, salvar }: { campo: CampoQuadro; busy: boolean; salvar: (o: Array<Partial<OpcaoCampo> & { name: string }>) => void }) {
  const t = useT();
  const [nomes, setNomes] = useState<Record<string, string>>({});
  const [corDe, setCorDe] = useState<string | null>(null);
  const [nova, setNova] = useState('');
  // a cor da próxima opção: a seguinte da paleta, para as etiquetas já nascerem diferentes
  const proxima = PALETA[(campo.options.length + 1) % PALETA.length];
  return (
    <div className="campos__opcoes">
      <ul>
        {campo.options.map((o) => (
          <li key={o.id}>
            <div className="row">
              <button type="button" className={`campos__cor tag tag--${corDaPaleta(o.color)}`} aria-expanded={corDe === o.id} disabled={busy}
                aria-label={t('quadro.campos.opcao.cor', { nome: o.name })} title={t('quadro.campos.opcao.cor', { nome: o.name })} onClick={() => setCorDe(corDe === o.id ? null : o.id)} />
              <input className="input grow" value={nomes[o.id] ?? o.name} maxLength={40} aria-label={t('quadro.campos.opcao.nome')}
                onChange={(e) => setNomes({ ...nomes, [o.id]: e.target.value })}
                onBlur={() => { const v = (nomes[o.id] ?? o.name).trim(); if (v && v !== o.name) salvar(campo.options.map((x) => (x.id === o.id ? { ...x, name: v } : x))); }} />
              <button type="button" className="icon-btn" disabled={busy} aria-label={t('quadro.campos.opcao.tirar', { nome: o.name })} title={t('quadro.campos.opcao.tirar', { nome: o.name })}
                onClick={() => salvar(campo.options.filter((x) => x.id !== o.id))}><Icon name="x" size={14} /></button>
            </div>
            {corDe === o.id && (
              <div className="campos__paleta" role="radiogroup" aria-label={t('quadro.campos.opcao.cor', { nome: o.name })}>
                {PALETA.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={corDaPaleta(o.color) === c} className={`campos__cor tag tag--${c} ${corDaPaleta(o.color) === c ? 'is-on' : ''}`}
                    aria-label={t(COR_ROTULO[c])} title={t(COR_ROTULO[c])} onClick={() => { setCorDe(null); if (c !== o.color) salvar(campo.options.map((x) => (x.id === o.id ? { ...x, color: c } : x))); }} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); const v = nova.trim(); if (v) { salvar([...campo.options, { name: v, color: proxima }]); setNova(''); } }}>
        <input className="input grow" value={nova} maxLength={40} placeholder={t('quadro.campos.opcao.nova')} aria-label={t('quadro.campos.opcao.nova')} onChange={(e) => setNova(e.target.value)} />
        <button className="btn btn--sm" disabled={busy || !nova.trim()}>{t('quadro.campos.opcao.adicionar')}</button>
      </form>
    </div>
  );
}

export function CamposDoQuadro({ quadroId, campos, espelho, onMudou }: { quadroId: string; campos: CampoQuadro[]; espelho?: string | null; onMudou: () => void }) {
  const t = useT();
  const [nomes, setNomes] = useState<Record<string, string>>({});
  const [aberto, setAberto] = useState<string | null>(null);
  const [apagando, setApagando] = useState<string | null>(null);
  const [novo, setNovo] = useState('');
  const [tipo, setTipo] = useState<TipoCampo>('text');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fazer = async (f: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await f(); onMudou(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const ordem = [...campos].sort((a, b) => a.position - b.position);
  const noCartao = ordem.filter((c) => c.showOnCard && c.type !== 'labels').length;

  return (
    <section className="campos" aria-labelledby="campos-t">
      <h4 id="campos-t">{t('quadro.campos.titulo')}</h4>
      <p className="hint">{t('quadro.campos.dica')}{espelho ? ` ${t('quadro.campos.soNoErgon', { app: espelho })}` : ''}</p>
      {err && <p className="error small" role="alert">{err}</p>}
      {!ordem.length && <p className="muted small">{t('quadro.campos.nenhum')}</p>}
      <ul className="campos__lista">
        {ordem.map((c, i) => (
          <li key={c.id} className="campos__item">
            <div className="row">
              <input className="input grow" value={nomes[c.id] ?? c.name} maxLength={40} aria-label={t('quadro.campos.nome')}
                onChange={(e) => setNomes({ ...nomes, [c.id]: e.target.value })}
                onBlur={() => { const v = (nomes[c.id] ?? c.name).trim(); if (v && v !== c.name) void fazer(() => api.patch(`/api/fields/${c.id}`, { name: v })); }} />
              <button className="icon-btn" disabled={busy || i === 0} aria-label={t('quadro.campos.subir', { nome: c.name })} title={t('quadro.campos.subir', { nome: c.name })} onClick={() => void fazer(() => api.patch(`/api/fields/${c.id}`, { position: i - 1 }))}><Icon name="chevron-up" size={16} /></button>
              <button className="icon-btn" disabled={busy || i === ordem.length - 1} aria-label={t('quadro.campos.descer', { nome: c.name })} title={t('quadro.campos.descer', { nome: c.name })} onClick={() => void fazer(() => api.patch(`/api/fields/${c.id}`, { position: i + 1 }))}><Icon name="chevron" size={16} /></button>
              <button className="icon-btn" disabled={busy} aria-label={t('quadro.campos.apagar', { nome: c.name })} title={t('quadro.campos.apagar', { nome: c.name })} aria-expanded={apagando === c.id} onClick={() => setApagando(apagando === c.id ? null : c.id)}><Icon name="trash" size={16} /></button>
            </div>
            <div className="row campos__linha2">
              <span className="badge">{t(TIPO_ROTULO[c.type])}</span>
              {temOpcoes(c.type) && <button type="button" className="linkish small" aria-expanded={aberto === c.id} onClick={() => setAberto(aberto === c.id ? null : c.id)}>{t('quadro.campos.opcoes', { n: c.options.length })}</button>}
              <span className="grow" />
              {c.type === 'labels'
                ? <span className="muted small">{t('quadro.campos.sempreNoCartao')}</span>
                : <label className="check small" title={t('quadro.campos.noCartaoDica')}><input type="checkbox" checked={c.showOnCard} disabled={busy || (!c.showOnCard && noCartao >= NO_CARTAO_MAX)}
                  onChange={(e) => void fazer(() => api.patch(`/api/fields/${c.id}`, { showOnCard: e.target.checked }))} /> {t('quadro.campos.noCartao')}</label>}
            </div>
            {aberto === c.id && temOpcoes(c.type) && <Opcoes campo={c} busy={busy} salvar={(options) => void fazer(() => api.patch(`/api/fields/${c.id}`, { options }))} />}
            {apagando === c.id && (
              <div className="gerir-quadro__confirma">
                <p className="small">{t('quadro.campos.apagarTexto', { nome: c.name })}</p>
                <div className="row">
                  <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => void fazer(async () => { await api.del(`/api/fields/${c.id}`); setApagando(null); })}>{t('quadro.campos.confirmarApagar')}</button>
                  <button className="btn btn--sm btn--ghost" onClick={() => setApagando(null)}>{t('quadro.gerir.cancelar')}</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form className="row campos__novo" onSubmit={(e) => { e.preventDefault(); if (novo.trim()) void fazer(async () => {
        const c = await api.post<CampoQuadro>(`/api/boards/${quadroId}/fields`, { name: novo, type: tipo }); setNovo('');
        if (temOpcoes(tipo)) setAberto(c.id); // lista e etiquetas: já abre para escrever as opções
      }); }}>
        <input className="input grow" value={novo} maxLength={40} placeholder={t('quadro.campos.novo')} aria-label={t('quadro.campos.novo')} onChange={(e) => setNovo(e.target.value)} />
        <select value={tipo} aria-label={t('quadro.campos.tipoRotulo')} onChange={(e) => setTipo(e.target.value as TipoCampo)}>{TIPOS.map((x) => <option key={x} value={x}>{t(TIPO_ROTULO[x])}</option>)}</select>
        <button className="btn btn--sm" disabled={busy || !novo.trim()}>{t('quadro.campos.adicionar')}</button>
      </form>
    </section>
  );
}
