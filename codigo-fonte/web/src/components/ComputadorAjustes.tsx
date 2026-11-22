import { useState } from 'react';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { AtivarAcessoTotal } from './AcessoTotal.tsx';
import { PassoDaPermissao, useComputador, type ModoComputador } from './ComputadorControle.tsx';
import { Icon } from './Icon.tsx';

const MODOS: ModoComputador[] = ['desligado', 'cada_acao', 'total'];

/**
 * Configurações › Controle do computador (rc.42): desligado, confirmar cada ação ou acesso total (ligar o acesso total
 * passa pelo mesmo cartão "Ativar acesso total?"); o Ergon Desktop conectado ou não; e, para quem administra, bloquear no
 * workspace. Ligar a ferramenta para os agentes continua no quadro de Ferramentas, acima.
 */
export function ComputadorAjustes() {
  const t = useT();
  const pc = useComputador();
  const [perguntar, setPerguntar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const e = pc.data;
  if (!e) return null;
  const enviar = async (rota: string, corpo: Record<string, unknown>) => {
    setOcupado(true); setErr(null);
    try { await api.put(rota, corpo); pc.reload(); } catch (x) { setErr(errMsg(x)); } finally { setOcupado(false); }
  };
  const escolher = (m: ModoComputador) => (m === 'total' && e.modo !== 'total' ? setPerguntar(true) : void enviar('/api/computador/modo', { modo: m }));
  const rotulo: Record<ModoComputador, string> = { desligado: t('configuracoes.computador.desligado'), cada_acao: t('configuracoes.computador.cadaAcao'), total: t('configuracoes.computador.total') };
  return (
    <section className={`card pc-ajustes ${e.modo === 'total' && !e.bloqueado ? 'pc-ajustes--total' : ''}`} aria-labelledby="pc-ajustes-t">
      <h3 id="pc-ajustes-t"><Icon name="monitor" size={18} /> {t('configuracoes.computador.titulo')}</h3>
      {!e.disponivel ? <p className="muted small">{t('configuracoes.computador.nuvem')}</p> : (<>
        <p className={`pc-aparelho ${e.aparelho.conectado ? 'pc-aparelho--on' : ''}`}>
          <span className="pc-aparelho__luz" aria-hidden="true" />
          {e.aparelho.conectado ? t('configuracoes.computador.conectado', { so: { linux: 'Linux', macos: 'macOS', windows: 'Windows' }[e.aparelho.so ?? ''] ?? '' }) : t('configuracoes.computador.abraODesktop')}
        </p>
        {e.aparelho.permissoes?.passo && <PassoDaPermissao passo={e.aparelho.permissoes.passo} />}
        <div className="seg pc-modos" role="radiogroup" aria-labelledby="pc-ajustes-t">
          {MODOS.map((m) => (
            <button key={m} role="radio" aria-checked={e.modo === m} className={`${e.modo === m ? 'is-on' : ''} ${m === 'total' ? 'pc-modos__total' : ''}`}
              disabled={ocupado || (e.bloqueado && m !== 'desligado')} onClick={() => escolher(m)}>{rotulo[m]}</button>
          ))}
        </div>
        {e.modo === 'desligado' && (
          <label className="check"><input type="checkbox" checked={!e.naoPerguntar} disabled={ocupado || e.bloqueado} onChange={(x) => void enviar('/api/computador/modo', { modo: 'desligado', naoPerguntar: !x.target.checked })} /> {t('configuracoes.computador.perguntar')}</label>
        )}
        {e.modo === 'cada_acao' && e.liberarTudo && <p className="hint">{t('configuracoes.computador.comLiberarTudo')}</p>}
        <p className="hint"><Icon name="lock" size={12} /> {t('configuracoes.computador.sempre')}</p>
        {e.administra && (
          <label className="check pc-bloqueio"><input type="checkbox" checked={e.bloqueado} disabled={ocupado} onChange={(x) => void enviar('/api/computador/bloqueio', { bloqueado: x.target.checked })} /> {t('configuracoes.computador.bloquear')}</label>
        )}
        {e.bloqueado && !e.administra && <p className="muted small">{t('configuracoes.computador.bloqueado')}</p>}
      </>)}
      {err && <p className="error" role="alert">{err}</p>}
      {/* o acesso total passa pela senha e pelo prazo (o mesmo cartão em todo lugar): libera também as ferramentas da equipe */}
      {perguntar && <AtivarAcessoTotal administra={!!e.administra} onCancelar={() => setPerguntar(false)} onFeito={() => { setPerguntar(false); pc.reload(); }} />}
    </section>
  );
}
