import { IDIOMAS, NOME_DO_IDIOMA, useIdioma, useT, type Idioma } from '../i18n/index.ts';
import { escolherIdioma } from '../lib/prefs.ts';

/**
 * O idioma da tela num dropdown (rc.49): a troca vale na hora (a tela inteira redesenha, sem recarregar) e fica guardada
 * na pessoa e neste navegador. Cada idioma aparece escrito nele mesmo. Compacto: no menu do avatar, o rótulo e o dropdown
 * na mesma linha; inteiro: Minha conta, com a explicação.
 */
export function SeletorIdioma({ compacto = false }: { compacto?: boolean }) {
  const t = useT();
  const atual = useIdioma();
  const id = compacto ? 'idioma-menu' : 'idioma-conta';
  return (
    <div className={`idioma ${compacto ? 'idioma--compacto' : ''}`} role={compacto ? 'group' : undefined} aria-labelledby={`${id}-t`}>
      {compacto ? <label id={`${id}-t`} htmlFor={id} className="muted small">{t('geral.idioma.titulo')}</label>
        : <><h4 id={`${id}-t`}>{t('geral.idioma.titulo')}</h4><p className="muted small">{t('geral.idioma.dica')}</p></>}
      <select id={id} className="idioma__select" value={atual} lang={atual} aria-labelledby={`${id}-t`}
        onChange={(e) => escolherIdioma(e.target.value as Idioma)}>
        {IDIOMAS.map((l) => <option key={l} value={l} lang={l}>{NOME_DO_IDIOMA[l]}</option>)}
      </select>
    </div>
  );
}
