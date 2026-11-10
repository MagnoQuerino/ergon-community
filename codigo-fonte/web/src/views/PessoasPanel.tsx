import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Me, PeopleInfo } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { cardClick } from '../lib/cardClick.ts';
import { textoRemoverPessoa } from '../lib/textos-tela.ts';
import { fmtDataHora, fmtLista, tn, useT } from '../i18n/index.ts';

const when = (iso: string | null) => (iso ? fmtDataHora(iso) : '—');

/**
 * Configurações › Pessoas (só quem administra): quem tem conta neste computador, quem pode criar conta nova e os
 * convites. Quem administra não vê nada do conteúdo de ninguém: só nomes, datas e se a frase pessoal já existe.
 */
export function PessoasPanel({ me }: { me: Me }) {
  const t = useT();
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
        <h3>{t('conta.pessoas.titulo')}</h3>
        <p className="muted">{d.isolated ? t('conta.pessoas.explica') : t('conta.pessoas.explicaAntes')}</p>
        <ul className="sec-rows">
          {d.people.map((p) => {
            const abrir = () => setAberta((a) => (a === p.id ? null : p.id));
            const eu = p.id === me.user.id;
            return (
              <li key={p.id} className="card-click" onClick={cardClick(abrir)}>
                <b><button type="button" className="card-open" onClick={abrir} aria-expanded={aberta === p.id} aria-controls={`pessoa-${p.id}`}>{p.displayName}</button></b>
                <span className="muted small">{t(p.admin ? 'conta.pessoas.linhaAdmin' : 'conta.pessoas.linha', { usuario: p.username, desde: when(p.createdAt), uso: when(p.lastSeen) })}</span>
                {!p.phrase && <span className="badge badge--warn" title={t('conta.pessoas.semFraseDica')}>{t('conta.seg.semFrase')}</span>}
                {!p.admin && p.id !== me.user.id && <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => setRemoving({ id: p.id, username: p.username, typed: '' })}>{t('conta.acao.remover')}</button>}
                {aberta === p.id && (
                  // os detalhes abertos são para ler e copiar: clicar neles não fecha (só a linha de cima alterna)
                  <dl id={`pessoa-${p.id}`} className="pessoa__det" data-card-skip>
                    <dt>{t('conta.campo.usuario')}</dt><dd>{eu ? t('conta.pessoas.voce', { usuario: p.username }) : p.username}</dd>
                    <dt>{t('conta.pessoas.papel')}</dt><dd>{p.admin ? t('conta.pessoas.papelAdmin') : t('conta.pessoas.papelComum')}</dd>
                    <dt>{t('conta.pessoas.criada')}</dt><dd>{when(p.createdAt)}</dd>
                    <dt>{t('conta.pessoas.ultimoUso')}</dt><dd>{p.lastSeen ? when(p.lastSeen) : t('conta.pessoas.nuncaEntrou')}</dd>
                    <dt>{t('conta.pessoas.frasePessoal')}</dt><dd>{p.phrase ? t('conta.pessoas.fraseOk') : eu ? t('conta.pessoas.fraseFaltaVoce') : t('conta.pessoas.fraseFaltaOutra')}</dd>
                    {p.migrated && <><dt>{t('conta.pessoas.dados')}</dt><dd>{eu ? t('conta.pessoas.dadosVoce') : t('conta.pessoas.dadosOutra')}</dd></>}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
        {removing && (
          <form className="lock-warn" role="alertdialog" aria-label={t('conta.pessoas.removerAria')} onSubmit={(e) => {
            e.preventDefault();
            void act('remove', async () => { await api.del(`/api/people/${removing.id}`, { confirm: removing.typed }); setRemoving(null); }, t('conta.pessoas.removida'));
          }}>
            <p><b>{t('conta.pessoas.removerPergunta', { usuario: removing.username })}</b> {textoRemoverPessoa(removing.username)}</p>
            <label className="field">{t('conta.pessoas.removerDigite')}<input required autoFocus value={removing.typed} onChange={(e) => setRemoving({ ...removing, typed: e.target.value })} /></label>
            <div className="row">
              <button className="btn btn--danger btn--sm" disabled={busy === 'remove' || removing.typed !== removing.username}>{busy === 'remove' ? t('conta.pessoas.removendo') : t('conta.pessoas.removerDeVez')}</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRemoving(null)}>{t('conta.acao.cancelar')}</button>
            </div>
          </form>
        )}
        {without.length > 0 && <p className="hint warn">{t('conta.pessoas.semFraseAviso', { n: without.length, nomes: fmtLista(without.map((p) => p.displayName)) })}</p>}
      </section>

      <section className="card">
        <h3>{t('conta.pessoas.contaNova')}</h3>
        <div className="radio-list" role="radiogroup" aria-label={t('conta.pessoas.quemPodeAria')}>
          <label className="check"><input type="radio" name="signup" checked={d.signup === 'aberto'} disabled={!!busy}
            onChange={() => void act('signup', () => api.put('/api/people/signup', { policy: 'aberto' }), t('conta.pessoas.abertoOk'))} />
            <span>{tn('conta.pessoas.abertoTexto', { quem: <b>{t('conta.pessoas.abertoQuem')}</b> })}</span></label>
          <label className="check"><input type="radio" name="signup" checked={d.signup === 'convite'} disabled={!!busy}
            onChange={() => void act('signup', () => api.put('/api/people/signup', { policy: 'convite' }), t('conta.pessoas.conviteOk'))} />
            <span>{tn('conta.pessoas.conviteTexto', { quem: <b>{t('conta.pessoas.conviteQuem')}</b> })}</span></label>
        </div>
        {d.signup === 'convite' && (
          <>
            {code
              ? <p className="ok" role="status">{tn('conta.pessoas.codigo', { codigo: <code className="invite-code">{code.code}</code>, ate: when(code.expiresAt) })}</p>
              : <button className="btn btn--sm" disabled={!!busy} onClick={() => void act('invite', async () => setCode(await api.post('/api/people/invites')))}>{t('conta.pessoas.gerarConvite')}</button>}
            {d.invites.length > 0 && (
              <ul className="sec-rows">
                {d.invites.map((i) => (
                  <li key={i.id}><span className="muted small">{t('conta.pessoas.conviteLinha', { criado: when(i.created_at), ate: when(i.expires_at) })}</span>
                    <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('revoke', () => api.del(`/api/people/invites/${i.id}`), t('conta.pessoas.conviteCancelado'))}>{t('conta.acao.cancelar')}</button></li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </>
  );
}
