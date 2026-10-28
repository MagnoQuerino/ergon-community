import { useRef, useState } from 'react';
import type { Me } from '../lib/types.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

/** Foto da pessoa (ou a inicial do nome, sem foto). */
export function Avatar({ me, size = 28 }: { me: Me; size?: number }) {
  const nome = me.user.displayName;
  return me.user.avatar
    ? <img className="avatar avatar--foto" src={me.user.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{nome[0]?.toUpperCase()}</span>;
}

/** Avatar no canto da barra: abre Minha conta, Alternar conta e Sair. */
export function AccountMenu({ me, onAccount, onLogout }: { me: Me; onAccount: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="topbar__acctwrap">
      <button className="topbar__acct" data-keep-surface onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
        aria-label={`Conta: ${me.user.displayName}`} title={me.user.displayName}>
        <Avatar me={me} size={30} />
      </button>
      {open && <Menu me={me} onClose={() => setOpen(false)} onAccount={() => { setOpen(false); onAccount(); }} onLogout={onLogout} />}
    </span>
  );
}

function Menu({ me, onClose, onAccount, onLogout }: { me: Me; onClose: () => void; onAccount: () => void; onLogout: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  return (
    <div ref={ref} className="status-pop acct-pop" role="menu" aria-label="Conta">
      <div className="acct-pop__who">
        <Avatar me={me} size={40} />
        <span><b>{me.user.displayName}</b><br /><span className="muted small">{me.user.username}</span></span>
      </div>
      <button className="acct-pop__item" role="menuitem" onClick={onAccount}><Icon name="gear" size={16} /> Minha conta</button>
      <button className="acct-pop__item" role="menuitem" onClick={onLogout} title="Sai desta conta e abre a entrada para outra conta deste computador">
        <Icon name="repeat" size={16} /> Alternar conta
      </button>
      <button className="acct-pop__item" role="menuitem" onClick={onLogout}><Icon name="logout" size={16} /> Sair</button>
    </div>
  );
}
