import { IDIOMAS, NOME_DO_IDIOMA, useIdioma, useT } from '../i18n/index.ts';
import { escolherIdioma } from '../lib/prefs.ts';

/**
 * Português / English: a troca vale na hora (a tela inteira redesenha, sem recarregar) e fica guardada na pessoa e neste
 * navegador. Cada idioma aparece escrito nele mesmo. Compacto: dentro do menu do avatar (role=menu), um grupo de itens
 * menuitemradio, que o leitor de tela anuncia como itens do menu; inteiro: Minha conta, um radiogroup com a explicação.
 */
export function SeletorIdioma({ compacto = false }: { compacto?: boolean }) {
  const t = useT();
  const atual = useIdioma();
  const papel = compacto ? 'menuitemradio' : 'radio';
  return (
    <div className={`idioma ${compacto ? 'idioma--compacto' : ''}`}>
      {compacto ? <span className="muted small" aria-hidden="true">{t('geral.idioma.titulo')}</span>
        : <><h4>{t('geral.idioma.titulo')}</h4><p className="muted small">{t('geral.idioma.dica')}</p></>}
      <div className="seg" role={compacto ? 'group' : 'radiogroup'} aria-label={t('geral.idioma.titulo')}>
        {IDIOMAS.map((l) => (
          <button key={l} type="button" role={papel} aria-checked={atual === l} lang={l} className={`seg__btn ${atual === l ? 'seg__btn--on' : ''}`}
            onClick={() => escolherIdioma(l)}>
            {NOME_DO_IDIOMA[l]}
          </button>
        ))}
      </div>
    </div>
  );
}
