import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Me, PeopleInfo } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * Configurações › Pessoas (só quem administra): quem tem conta neste computador, quem pode criar conta nova e os
 * convites. Quem administra não vê nada do conteúdo de ninguém: só nomes, datas e se a frase pessoal já existe.
 */
export function PessoasPanel({ me }: { me: Me }) {
  const res = useResource<PeopleInfo>('/api/people', []);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; username: string; typed: string } | null>(null);
  const d = res.data;
  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null); setBusy(label);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); res.reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(null); }
  };
  if (!d) return <Loading error={res.error} />;
  const without = d.people.filter((p) => !p.phrase);

  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      <section className="card">
        <h3>Pessoas neste computador</h3>
        <p className="muted">Cada pessoa tem a própria conta, a própria equipe e o próprio motor de IA. Os dados de cada uma ficam cifrados com a chave dela: você administra o Ergon, mas não vê nada do que é dos outros{d.isolated ? '' : ' (o isolamento começa quando a segunda pessoa criar a conta)'}.</p>
        <ul className="sec-rows">
          {d.people.map((p) => (
            <li key={p.id}>
              <b>{p.displayName}</b>
              <span className="muted small">{p.username}{p.admin ? ' · administra' : ''} · desde {when(p.createdAt)} · último uso {when(p.lastSeen)}</span>
              {!p.phrase && <span className="badge badge--warn" title="Sem a frase pessoal confirmada, uma senha esquecida trava os dados dessa pessoa para sempre.">sem frase</span>}
              {!p.admin && p.id !== me.user.id && <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => setRemoving({ id: p.id, username: p.username, typed: '' })}>Remover</button>}
            </li>
          ))}
        </ul>
        {removing && (
          <form className="lock-warn" role="alertdialog" aria-label="Remover conta" onSubmit={(e) => {
            e.preventDefault();
            void act('remove', async () => { await api.del(`/api/people/${removing.id}`, { confirm: removing.typed }); setRemoving(null); }, 'Conta removida: a chave dela saiu primeiro, depois os dados, os arquivos e o motor dela.');
          }}>
            <p><b>Remover a conta de {removing.username}?</b> A equipe, as conversas, as tarefas, os arquivos, as conexões e o motor de IA dessa pessoa são apagados de vez — nem você nem ela conseguem recuperar. Se ela quiser guardar algo, peça para baixar antes; e faça um backup (Configurações › Saúde) se tiver dúvida.</p>
            <label className="field">Digite o usuário dela para confirmar<input required autoFocus value={removing.typed} onChange={(e) => setRemoving({ ...removing, typed: e.target.value })} /></label>
            <div className="row">
              <button className="btn btn--danger btn--sm" disabled={busy === 'remove' || removing.typed !== removing.username}>{busy === 'remove' ? 'Removendo…' : 'Remover de vez'}</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRemoving(null)}>Cancelar</button>
            </div>
          </form>
        )}
        {without.length > 0 && <p className="hint warn">{without.map((p) => p.displayName).join(', ')} ainda {without.length > 1 ? 'não geraram' : 'não gerou'} a frase pessoal (Configurações › Segurança). Antes disso, ninguém mais consegue criar conta aqui.</p>}
      </section>

      <section className="card">
        <h3>Conta nova</h3>
        <div className="radio-list" role="radiogroup" aria-label="Quem pode criar conta">
          <label className="check"><input type="radio" name="signup" checked={d.signup === 'aberto'} disabled={!!busy}
            onChange={() => void act('signup', () => api.put('/api/people/signup', { policy: 'aberto' }), 'Qualquer pessoa neste computador pode criar a própria conta.')} />
            <span><b>Qualquer pessoa neste computador</b> cria a própria conta na tela de entrada (recomendado: cada conta só vê o que é dela).</span></label>
          <label className="check"><input type="radio" name="signup" checked={d.signup === 'convite'} disabled={!!busy}
            onChange={() => void act('signup', () => api.put('/api/people/signup', { policy: 'convite' }), 'Conta nova só com convite.')} />
            <span><b>Só com convite</b>: você gera um código de uso único e entrega à pessoa.</span></label>
        </div>
        {d.signup === 'convite' && (
          <>
            {code
              ? <p className="ok" role="status">Código do convite: <code className="invite-code">{code.code}</code> — vale uma vez, até {when(code.expiresAt)}. Ele aparece só agora.</p>
              : <button className="btn btn--sm" disabled={!!busy} onClick={() => void act('invite', async () => setCode(await api.post('/api/people/invites')))}>Gerar convite</button>}
            {d.invites.length > 0 && (
              <ul className="sec-rows">
                {d.invites.map((i) => (
                  <li key={i.id}><span className="muted small">convite de {when(i.created_at)} · vale até {when(i.expires_at)}</span>
                    <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('revoke', () => api.del(`/api/people/invites/${i.id}`), 'Convite cancelado.')}>Cancelar</button></li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </>
  );
}
