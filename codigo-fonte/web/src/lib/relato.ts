// "Relatar um problema" (Ajuda): a lógica do formulário, sem React (testável). O servidor local limpa e monta o relato
// (server/src/services/relatos.ts); a tela mostra a prévia que ele devolve e só envia no clique em "Enviar relato".
import type { Chave } from '../i18n/index.ts';

// i18n-ok: os códigos das categorias (o receptor só aceita estes); o rótulo de cada um vem do dicionário
export const CATEGORIAS = ['erro', 'lento', 'aparencia', 'conexao', 'agentes', 'instalacao', 'sugestao', 'outro'] as const;
export type Categoria = typeof CATEGORIAS[number];
export const ROTULO_CATEGORIA = {
  erro: 'ajuda.relato.cat.erro', lento: 'ajuda.relato.cat.lento', aparencia: 'ajuda.relato.cat.aparencia', conexao: 'ajuda.relato.cat.conexao',
  agentes: 'ajuda.relato.cat.agentes', instalacao: 'ajuda.relato.cat.instalacao', sugestao: 'ajuda.relato.cat.sugestao', outro: 'ajuda.relato.cat.outro',
} as const satisfies Record<Categoria, Chave>;
/** O que entra com "Incluir dados técnicos" (as chaves fixas do servidor, na mesma ordem). */
export const DADOS_TECNICOS = ['ajuda.relato.dado.versaoMotor', 'ajuda.relato.dado.motorAtivo', 'ajuda.relato.dado.idioma', 'ajuda.relato.dado.codigosErro',
  'ajuda.relato.dado.memoriaMb', 'ajuda.relato.dado.arquitetura'] as const satisfies readonly Chave[];
export const LIMITES = { titulo: [5, 120], descricao: [10, 4000], passos: [0, 2000], esperado: [0, 1000] } as const;

export interface FormRelato { categoria: Categoria | ''; titulo: string; descricao: string; passos: string; esperado: string; dadosTecnicos: boolean }
export const FORM_VAZIO: FormRelato = { categoria: '', titulo: '', descricao: '', passos: '', esperado: '', dadosTecnicos: false };

export const ehCategoria = (v: unknown): v is Categoria => typeof v === 'string' && (CATEGORIAS as readonly string[]).includes(v);

/** A categoria do endereço (#ajuda?relatar=erro), vinda de um card de erro. */
export function categoriaDoEndereco(hash: string): Categoria | '' {
  const v = new URLSearchParams(hash.split('?')[1] ?? '').get('relatar');
  return ehCategoria(v) ? v : '';
}
export const enderecoDoRelato = (c?: Categoria) => `#ajuda?relatar${c ? `=${c}` : ''}`;

/** O que falta para poder ver a prévia (a chave do aviso), ou null. */
export function faltaNoRelato(f: FormRelato): 'ajuda.relato.falta.categoria' | 'ajuda.relato.falta.titulo' | 'ajuda.relato.falta.descricao' | null {
  if (!f.categoria) return 'ajuda.relato.falta.categoria';
  if (f.titulo.trim().length < LIMITES.titulo[0]) return 'ajuda.relato.falta.titulo';
  if (f.descricao.trim().length < LIMITES.descricao[0]) return 'ajuda.relato.falta.descricao';
  return null;
}

export type Sistema = 'windows' | 'linux' | 'macos' | 'outro';
export function sistemaDoNavegador(ua: string): Sistema {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  return 'outro';
}

// os últimos códigos de erro que a tela recebeu (lib/api.ts anota): só o código, nunca a mensagem
const CODIGO = /^[a-z0-9_.]{1,60}$/;
const recentes: string[] = [];
export function anotarCodigoErro(c: string): void {
  if (!CODIGO.test(c)) return;
  const i = recentes.indexOf(c); if (i >= 0) recentes.splice(i, 1);
  recentes.push(c); if (recentes.length > 20) recentes.shift();
}
export const codigosRecentes = (): string[] => [...recentes];

/** O corpo para /api/relatos/previa e /api/relatos/enviar (o mesmo nos dois: a prévia é o que vai). */
export function pedidoDoRelato(f: FormRelato, sistema: Sistema, codigos: string[] = codigosRecentes()) {
  if (!f.categoria) throw new Error('categoria');
  return {
    categoria: f.categoria, titulo: f.titulo.trim(), descricao: f.descricao.trim(), sistema,
    ...(f.passos.trim() ? { passos: f.passos.trim() } : {}),
    ...(f.esperado.trim() ? { esperado: f.esperado.trim() } : {}),
    ...(f.dadosTecnicos ? { dadosTecnicos: true, codigosErro: codigos.filter((c) => CODIGO.test(c)).slice(-20) } : {}),
  };
}

/** O texto da prévia e do "Copiar texto": o JSON exato que sai. */
export const textoDoRelato = (relato: unknown): string => JSON.stringify(relato, null, 2);

/** A frase de cada falha do envio (pelo código do servidor local). */
export function falhaDoEnvio(code: string): 'ajuda.relato.erro.limite' | 'ajuda.relato.indisponivel' | 'ajuda.relato.erro.curto' | 'ajuda.relato.erro.naoEnviado' {
  if (code === 'relato_limite') return 'ajuda.relato.erro.limite';
  if (code === 'relato_indisponivel') return 'ajuda.relato.indisponivel';
  if (code === 'relato_curto') return 'ajuda.relato.erro.curto';
  return 'ajuda.relato.erro.naoEnviado';
}
