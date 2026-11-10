import { useRef } from 'react';
import type { Me } from '../lib/types.ts';
import { useSurface } from '../lib/surface.ts';
import { useBalao } from '../lib/balao.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import { SeletorIdioma } from './SeletorIdioma.tsx';

/** Foto da pessoa (ou a inicial do nome, sem foto). */
export function Avatar({ me, size = 28 }: { me: Me; size?: number }) {
  const nome = me.user.displayName;
  return me.user.avatar
    ? <img className="avatar avatar--foto" src={me.user.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{nome[0]?.toUpperCase()}</span>;
}

/** Avatar no canto da barra: abre Minha conta, o idioma, Alternar conta e Sair. */
export function AccountMenu({ me, onAccount, onLogout }: { me: Me; onAccount: () => void; onLogout: () => void }) {
  const t = useT();
  const [open, setOpen] = useBalao('conta');
  return (
    <span className="topbar__acctwrap">
      <button className="topbar__acct" data-keep-surface onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
        aria-label={t('geral.conta.aria', { nome: me.user.displayName })} title={me.user.displayName}>
        <Avatar me={me} size={30} />
      </button>
      {open && <Menu me={me} onClose={() => setOpen(false)} onAccount={() => { setOpen(false); onAccount(); }} onLogout={onLogout} />}
    </span>
  );
}

function Menu({ me, onClose, onAccount, onLogout }: { me: Me; onClose: () => void; onAccount: () => void; onLogout: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  return (
    <div ref={ref} className="status-pop acct-pop" role="menu" aria-label={t('geral.conta.menu')}>
      <div className="acct-pop__who">
        <Avatar me={me} size={40} />
        <span><b>{me.user.displayName}</b><br /><span className="muted small">{me.user.username}</span></span>
      </div>
      <button className="acct-pop__item" role="menuitem" onClick={onAccount}><Icon name="gear" size={16} /> {t('geral.conta.minha')}</button>
      {/* Português / English: troca na hora, sem fechar o menu (escondido até o inglês ser liberado) */}
      <SeletorIdioma compacto />
      <button className="acct-pop__item" role="menuitem" onClick={onLogout} title={t('geral.conta.alternarDica')}>
        <Icon name="repeat" size={16} /> {t('geral.conta.alternar')}
      </button>
      <button className="acct-pop__item" role="menuitem" onClick={onLogout}><Icon name="logout" size={16} /> {t('geral.conta.sair')}</button>
    </div>
  );
}
