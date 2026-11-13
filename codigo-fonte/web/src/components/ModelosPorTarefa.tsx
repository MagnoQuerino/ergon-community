import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { ModelCatalog } from '../lib/types.ts';
import {
  TAREFA_AJUDANTES, comModeloProprio, enderecoDaEconomia, enderecoDaLista, mudancasDaEconomia, situacaoDaEconomia, textoDaTarefa,
  type ContaDoCusto, type EconomySuggestion, type TaskModelChange, type TaskModelRow, type TaskModels,
} from '../lib/modelos-tarefa.ts';
import { ModelSelect, modelName } from './AgentProfile.tsx';
import { useT, type Chave } from '../i18n/index.ts';

/**
 * Modelos por tarefa: seção recolhida onde se escolhe o modelo (Conexões › modelo padrão e a janela do agente). Lista
 * TODAS as tarefas de apoio que a equipe de IA tiver, cada uma com "Usar o principal" de saída, o nome claro, o que faz,
 * o seletor (os modelos das contas conectadas) e de qual conta sai o custo; e a linha dos ajudantes temporários.
 * `perfil`: o perfil do agente; sem ele, a escolha vale para a equipe da pessoa (`deTodaEquipe` avisa isso na janela do
 * agente, enquanto cada agente não tem o próprio perfil).
 */
export function ModelosPorTarefa({ perfil, deTodaEquipe = false }: { perfil?: string | null; deTodaEquipe?: boolean }) {
  const t = useT();
  const catalog = useResource<ModelCatalog>('/api/ai/models', ['ai.changed']);
  const lista = useResource<TaskModels>(enderecoDaLista(perfil), ['ai.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmar, setConfirmar] = useState<{ texto: string; mudancas: TaskModelChange[] } | null>(null);
  const [previa, setPrevia] = useState<EconomySuggestion | null>(null);

  // as chaves das tarefas não têm marcadores: a tradução é direta
  const tr = t as (k: Chave) => string;
  const nomeDe = (row: Pick<TaskModelRow, 'task' | 'declared'>): string => { const x = textoDaTarefa(row).nome; return 'chave' in x ? tr(x.chave) : x.texto; };
  const oQueFaz = (row: TaskModelRow): string | null => { const x = textoDaTarefa(row).oque; return !x ? null : 'chave' in x ? tr(x.chave) : x.texto; };
  const conta = (c: ContaDoCusto | null): string => (!c ? t('conexoes.tarefas.semConta') : c.billing === 'subscription' ? t('conexoes.tarefas.contaAssinatura', { conta: c.name }) : c.name);
  const modelo = (id: string | null): string => (id ? modelName(id, catalog.data) : t('conexoes.tarefas.semModelo'));

  const gravar = async (mudancas: TaskModelChange[], confirm = false, feito?: string) => {
    setMsg(null);
    try {
      const r = await api.put<{ ok: boolean; confirmMessage: string | null; applied: string[] }>('/api/ai/task-models', { changes: mudancas, confirm, ...(perfil ? { perfil } : {}) });
      lista.reload();
      if (!r.ok && r.confirmMessage) { setConfirmar({ texto: r.confirmMessage, mudancas: mudancas.filter((m) => !r.applied.includes(m.task)) }); return; }
      setConfirmar(null); setPrevia(null);
      setMsg({ kind: 'ok', text: feito ?? t('conexoes.tarefas.salvo') });
    } catch (e) { lista.reload(); setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const verEconomia = async () => {
    setMsg(null); setConfirmar(null);
    try { setPrevia(await api.get<EconomySuggestion>(enderecoDaEconomia(perfil))); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  // sem conta conectada não há o que escolher (a seção do modelo padrão também fica de fora)
  if (catalog.data && !catalog.data.providers.length) return null;
  const tm = lista.data;
  const proprias = comModeloProprio(tm);
  const situacao = previa ? situacaoDaEconomia(previa) : null;
  return (
    <details className="modelos-tarefa">
      <summary>
        <b>{t('conexoes.tarefas.titulo')}</b>
        <span className="muted small">{!tm || !tm.supported ? '' : proprias ? t('conexoes.tarefas.resumoProprias', { n: proprias }) : t('conexoes.tarefas.resumoTodas')}</span>
        <span className="modelos-tarefa__acao" aria-hidden="true">
          <span className="modelos-tarefa__abrir">{t('conexoes.tarefas.ajustar')}</span>
          <span className="modelos-tarefa__fechar">{t('conexoes.tarefas.recolher')}</span>
          <span className="modelos-tarefa__seta">▸</span>
        </span>
      </summary>
      <p className="hint">{t('conexoes.tarefas.texto')}</p>
      {deTodaEquipe && <p className="hint">{t('conexoes.tarefas.todaEquipe')}</p>}
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {lista.error && !tm && <p className="hint">{t('conexoes.tarefas.falhou')} <button type="button" className="btn btn--sm btn--ghost" onClick={() => lista.reload()}>{t('conexoes.tarefas.tentarDeNovo')}</button></p>}
      {tm && !tm.supported && <p className="hint">{t('conexoes.tarefas.naoChegou')}</p>}
      {tm?.supported && (
        <>
          <div className="modelos-tarefa__economia">
            <button type="button" className="btn btn--ghost" onClick={() => void verEconomia()}>{t('conexoes.economia.botao')}</button>
            <span className="hint">{t('conexoes.economia.dica')}</span>
          </div>
          {previa && situacao && (
            <div className="confirm modelos-tarefa__previa" role="group" aria-label={t('conexoes.economia.titulo')}>
              {situacao === 'mudancas' ? (
                <>
                  <b>{t('conexoes.economia.titulo')}</b>
                  <ul>
                    {previa.changes.map((c) => (
                      <li key={c.task}>{t('conexoes.economia.linha', { tarefa: nomeDe(c), de: modelo(c.from.model), contaDe: conta(c.from.account), para: modelo(c.to.model), contaPara: conta(c.to.account) })}</li>
                    ))}
                    {previa.kept.map((k) => (
                      <li key={k.task} className="muted">{t(k.reason === 'vision' ? 'conexoes.economia.ficaImagens' : 'conexoes.economia.ficaIgual', { tarefa: nomeDe(k) })}</li>
                    ))}
                  </ul>
                  <p className="hint">{t('conexoes.economia.aviso')}</p>
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => void gravar(mudancasDaEconomia(previa), false, t('conexoes.economia.aplicado', { n: previa.changes.length }))}>{t('conexoes.economia.aplicar')}</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPrevia(null)}>{t('conexoes.acao.cancelar')}</button>
                </>
              ) : (
                <>
                  <span>{t(situacao === 'principal' ? 'conexoes.economia.nadaPrincipal' : situacao === 'semModelo' ? 'conexoes.economia.nadaSemModelo' : situacao === 'atualizar' ? 'conexoes.tarefas.naoChegou' : 'conexoes.economia.nadaJaEsta')}</span>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPrevia(null)}>{t('conexoes.economia.fechar')}</button>
                </>
              )}
            </div>
          )}
          {confirmar && (
            <div className="confirm">{confirmar.texto}
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void gravar(confirmar.mudancas, true)}>{t('conexoes.modelo.usarMesmoAssim')}</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmar(null)}>{t('conexoes.acao.cancelar')}</button>
            </div>
          )}
          <ul className="modelos-tarefa__lista">
            {tm.tasks.map((row) => {
              const id = `modelo-tarefa-${row.task}`;
              const ajudantes = row.task === TAREFA_AJUDANTES;
              const principal = ajudantes ? t('conexoes.tarefas.usarDoAgente') : tm.main.model ? t('conexoes.tarefas.usarPrincipalCom', { modelo: modelo(tm.main.model) }) : t('conexoes.tarefas.usarPrincipal');
              return (
                <li key={row.task} className="modelos-tarefa__linha">
                  <label htmlFor={id}>
                    <b>{nomeDe(row)}</b>
                    {oQueFaz(row) && <span className="hint">{oQueFaz(row)}</span>}
                    {row.declared?.by && <span className="hint">{t('conexoes.tarefas.deComplemento', { nome: row.declared.by })}</span>}
                    {row.declared?.follows && !row.model && <span className="hint">{t('conexoes.tarefas.segue', { tarefa: nomeDe({ task: row.declared.follows }) })}</span>}
                  </label>
                  <div className="modelos-tarefa__escolha">
                    <ModelSelect id={id} catalog={catalog.data} value={row.model} provider={row.provider} defaultLabel={principal}
                      onChange={(model, provider) => void gravar([{ task: row.task, provider, model }], false, t('conexoes.tarefas.salvoDe', { tarefa: nomeDe(row) }))} />
                    <span className="hint">{t('conexoes.tarefas.custo', { conta: conta(row.runs.account) })}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </details>
  );
}
