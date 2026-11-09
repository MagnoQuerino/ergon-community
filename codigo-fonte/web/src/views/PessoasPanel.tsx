import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Me, PeopleInfo } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { cardClick } from '../lib/cardClick.ts';
import { textoRemoverPessoa } from '../lib/textos-tela.ts';

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
  // a linha inteira abre (e fecha) os detalhes da pessoa: só o que quem administra pode ver, nada do conteúdo dela
  const [aberta, setAberta] = useState<string | null>(null);
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
        <p className="muted">Cada pessoa tem a própria conta e a própria equipe de IA. Os dados de cada uma ficam cifrados com a chave dela: você administra o Ergon, mas não vê nada do que é dos outros{d.isolated ? '' : ' (o isolamento começa quando a segunda pessoa criar a conta)'}.</p>
        <ul className="sec-rows">
          {d.people.map((p) => {
            const abrir = () => setAberta((a) => (a === p.id ? null : p.id));
            const eu = p.id === me.user.id;
            return (
              <li key={p.id} className="card-click" onClick={cardClick(abrir)}>
                <b><button type="button" className="card-open" onClick={abrir} aria-expanded={aberta === p.id} aria-controls={`pessoa-${p.id}`}>{p.displayName}</button></b>
                <span className="muted small">{p.username}{p.admin ? ' · administra' : ''} · desde {when(p.createdAt)} · último uso {when(p.lastSeen)}</span>
                {!p.phrase && <span className="badge badge--warn" title="Sem a frase pessoal confirmada, uma senha esquecida trava os dados dessa pessoa para sempre.">sem frase</span>}
                {!p.admin && p.id !== me.user.id && <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => setRemoving({ id: p.id, username: p.username, typed: '' })}>Remover</button>}
                {aberta === p.id && (
                  // os detalhes abertos são para ler e copiar: clicar neles não fecha (só a linha de cima alterna)
                  <dl id={`pessoa-${p.id}`} className="pessoa__det" data-card-skip>
                    <dt>Usuário</dt><dd>{p.username}{eu ? ' (você)' : ''}</dd>
                    <dt>Papel</dt><dd>{p.admin ? 'Administra o Ergon neste computador: pessoas, convites e conta nova. Não vê o conteúdo dos outros.' : 'Usa a própria conta e a própria equipe de IA.'}</dd>
                    <dt>Conta criada</dt><dd>{when(p.createdAt)}</dd>
                    <dt>Último uso</dt><dd>{p.lastSeen ? when(p.lastSeen) : 'Ainda não entrou.'}</dd>
                    <dt>Frase pessoal</dt><dd>{p.phrase ? 'Confirmada: com ela, uma senha esquecida não trava os dados.' : eu ? 'Ainda não confirmada. Sem ela, uma senha esquecida trava os seus dados para sempre. Você gera em Configurações › Segurança.' : 'Ainda não confirmada. Sem ela, uma senha esquecida trava os dados dessa pessoa para sempre. Ela gera em Configurações › Segurança.'}</dd>
                    {p.migrated && <><dt>Dados</dt><dd>{eu ? 'Cifrados com a sua chave: só você abre.' : 'Cifrados com a chave dela: só ela abre, ao entrar com a própria senha.'}</dd></>}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
        {removing && (
          <form className="lock-warn" role="alertdialog" aria-label="Remover conta" onSubmit={(e) => {
            e.preventDefault();
            void act('remove', async () => { await api.del(`/api/people/${removing.id}`, { confirm: removing.typed }); setRemoving(null); }, 'Conta removida: a chave dela saiu primeiro, depois os dados, os arquivos e a equipe de IA dela.');
          }}>
            <p><b>Remover a conta de {removing.username}?</b> {textoRemoverPessoa(removing.username)}</p>
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
