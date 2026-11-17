/**
 * O cartão de um comando que o motor segura para a pessoa aprovar (rc.33, aprovacoes.ts). Quem decide não precisa ler
 * código: o cartão diz, numa frase, o que o agente quer fazer e para quê ("Hipátia quer rodar um pequeno programa em
 * Python para calcular datas, no trabalho “Calendário de março”."), com uma etiqueta do risco quando dá para dizer com
 * segurança ("só calcula", "mexe em arquivos", "usa a internet", "apaga"). O comando em si fica em "Ver detalhes
 * técnicos" (a tela), sem os caminhos internos do motor; nunca no texto do cartão, nem no Teams, Telegram, Discord e
 * WhatsApp.
 *
 * De onde vem a frase, nesta ordem: o motivo que o agente der (o motor de hoje não manda: a "description" do pedido é o
 * nome da regra de perigo dele, em inglês, e nunca aparece), a etapa ou o card em que a execução está, e por último o que
 * se lê do próprio comando (a linguagem e o que ele faz). O risco é conservador: na dúvida, sem etiqueta.
 */
import { limparCaminhos } from '../../../shared/caminhos.ts';
import { emPt, tx, type Codigo, type Texto } from '../lib/textos.ts';

/** O que o comando faz, em linguagem simples (o código do catálogo: proposta.aprovacao.acao.<acao>). */
export type AcaoDoComando = 'programa' | 'programaEm' | 'comandos' | 'apagar' | 'apagarDados' | 'desinstalar' | 'descartar' | 'formatar'
  | 'internetRodar' | 'publicarForcado' | 'configuracao' | 'parar' | 'administrador' | 'senhas' | 'disfarcado' | 'instalar' | 'baixar' | 'comando';
export type Risco = 'calcula' | 'arquivos' | 'internet' | 'apaga';
/** Para que serve, lido do código (proposta.aprovacao.obj.<objetivo>). */
export type Objetivo = 'datas' | 'tamanho' | 'dados' | 'contas' | 'calculo';

/**
 * As regras de perigo do motor (tools/approval_detection.py, a "description" de cada uma) pelo que fazem. A ordem importa:
 * a primeira que casa decide. O que não está aqui vira "rodar um comando no computador".
 */
const REGRAS: ReadonlyArray<readonly [RegExp, AcaoDoComando, Risco | null]> = [
  [/uninstall/i, 'desinstalar', 'apaga'],
  [/\bsql\b/i, 'apagarDados', 'apaga'],
  [/format|mkfs|partition|diskpart|block device|disk copy|\bdd\b|shadow cop|wbadmin|backups/i, 'formatar', 'apaga'],
  [/git reset|git clean|git branch force delete/i, 'descartar', 'apaga'],
  [/delete|\brm\b|remove-item|registry/i, 'apagar', 'apaga'],
  [/remote content|remote script|invoke-expression|\biwr\b/i, 'internetRodar', 'internet'],
  [/force push/i, 'publicarForcado', 'internet'],
  [/exfiltration|upload/i, 'senhas', 'internet'],
  [/credential|ssh key|secrets|metadata endpoint/i, 'senhas', null],
  [/script execution via/i, 'programa', null],
  [/shell (command|execution) via/i, 'comandos', null],
  [/obfuscation|invisible|bidirectional|dynamic shell word|encoded command/i, 'disfarcado', null],
  [/in-place edit|overwrite|copy\/move|\btee\b|redirection|chown|chmod|writable|icacls|acl|boot configuration|env\/config/i, 'configuracao', 'arquivos'],
  [/kill|stop|restart|shutdown|reboot|init 0|docker|podman|hermes update|gateway|fork bomb/i, 'parar', null],
  [/sudo|privilege/i, 'administrador', null],
];

// o que o código mostra que faz (conservador: só o que é claro)
const APAGA = /\brm\s+\S|\brmdir\b|\bunlink\b|os\.remove|shutil\.rmtree|\.unlink\(|rmSync|unlinkSync|\bdelete\s+from\b|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b|Remove-Item|-delete\b/i;
const INTERNET = /https?:\/\/|\bcurl\b|\bwget\b|\brequests\b|urllib|http\.client|\bsocket\b|\bfetch\(|\bpip3?\s+install\b|\bnpm\s+(?:i|install|ci)\b|\bapt(?:-get)?\s+install\b|\bgit\s+(?:clone|push|pull|fetch)\b|\bssh\b|\bscp\b|\brsync\b/i;
const ESCREVE = /\bopen\([^)]*['"][wax]\+?b?['"]/;
const REDIRECIONA = /\s>{1,2}\s*(?!\/dev\/null)[~./$\w-]*\.[a-z][a-z0-9]{0,4}\b/i;
const ARQUIVOS = /\.write\(|write_text|write_bytes|writeFileSync|appendFile|\bmv\s|\bcp\s|\bmkdir\b|\btouch\b|\btee\b|\bsed\s+-i|\bchmod\b|\bchown\b|shutil\.(?:copy|move)|os\.(?:rename|makedirs|mkdir|replace)/i;
const INSTALA = /\bpip3?\s+install\b|\bnpm\s+(?:i|install)\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b/i;
const BAIXA = /\bcurl\b|\bwget\b/i;
/** dentro de um programa, o que sai das contas: arquivos, outros programas, a rede, o sistema */
const SAI_DAS_CONTAS = /\bopen\(|\bos\b|subprocess|shutil|pathlib|socket|\bsys\.|\beval\(|\bexec\(|__import__|require\(|child_process|\bfs\b|\bprocess\.|import\s+(?:os|sys|subprocess|shutil|pathlib|socket|requests|urllib|http)|\bsystem\(|`/;

const LINGUAGENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^python[23]?(?:\.\d+)?$/, 'Python'], [/^(?:node|nodejs|deno|bun)$/, 'JavaScript'], [/^perl$/, 'Perl'], [/^ruby$/, 'Ruby'], [/^php$/, 'PHP'],
];

/** O programa inline de um comando (python3 -c "…", node -e '…', python3 <<'EOF' … EOF): a linguagem e o código. */
export function programaDoComando(comando: string): { linguagem: string | null; codigo: string; soOPrograma: boolean } | null {
  const c = String(comando ?? '').trim();
  // python3 <<'EOF' … EOF (com ou sem aspas e hífen)
  const h = /^(?:cd\s+\S+\s*&&\s*)?(\S+)\s+(?:-\s+)?<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*$/.exec(c);
  if (h) return { linguagem: linguagemDe(h[1]), codigo: h[4], soOPrograma: !!linguagemDe(h[1]) };
  // python3 -c "…" (o código entre as aspas; o que vier depois disso é outro comando)
  const e = /^(?:cd\s+\S+\s*&&\s*)?(\S+)\s+(?:-\w+\s+)*-[ce]\s+(["'])([\s\S]*)\2\s*$/.exec(c);
  if (e) return { linguagem: linguagemDe(e[1]), codigo: e[3], soOPrograma: !!linguagemDe(e[1]) && !semAspasDentro(e[3], e[2]) };
  const s = /^(?:cd\s+\S+\s*&&\s*)?(\S+)\s+(?:-\w+\s+)*-[ce]\s+(["'])([\s\S]*)$/.exec(c);
  if (s) return { linguagem: linguagemDe(s[1]), codigo: s[3], soOPrograma: false };
  return null;
}
const linguagemDe = (exe: string): string | null => {
  const nome = exe.split('/').pop() ?? exe;
  return LINGUAGENS.find(([re]) => re.test(nome))?.[1] ?? null;
};
/** a aspa que abriu aparece sem escape no meio: o "código" emenda outro comando do shell (python -c "x" && rm …) */
const semAspasDentro = (codigo: string, aspa: string): boolean => new RegExp(`(?<!\\\\)${aspa === '"' ? '"' : "'"}`).test(codigo);

/** o código sem os textos entre aspas (uma legenda com "os" ou "rm" não é o programa fazendo nada) */
const semTextos = (codigo: string): string => codigo.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

/** O risco que o comando mostra, sem adivinhar: null quando não dá para dizer com segurança. */
export function riscoDoComando(comando: string, daRegra: Risco | null = null): Risco | null {
  const c = String(comando ?? '');
  const p = programaDoComando(c);
  // só um programa: o que conta é o código dele, fora dos textos; um comando do shell: ele inteiro
  const so = p?.soOPrograma ? p.codigo : null;
  const alvo = so !== null ? semTextos(so) : c;
  if (daRegra === 'apaga' || APAGA.test(alvo)) return 'apaga';
  if (daRegra === 'internet' || INTERNET.test(alvo) || (so !== null && /https?:\/\//.test(so) && /\b(?:get|post|open|fetch|download|request)\w*\(/i.test(alvo))) return 'internet';
  if (daRegra === 'arquivos' || ARQUIVOS.test(alvo) || ESCREVE.test(so ?? c) || (so === null && REDIRECIONA.test(c))) return 'arquivos';
  if (so !== null && so.trim() && !SAI_DAS_CONTAS.test(alvo)) return 'calcula';
  return null;
}

/** Para que serve o programa, quando o código deixa claro (só nos programas que só calculam). */
function objetivoDoPrograma(codigo: string): Objetivo {
  if (/\bcalendar\b|\bdatetime\b|\btimedelta\b|\bnew Date\b|\bDate\.|\bweekday\b/.test(codigo)) return 'datas';
  if (/\blen\(|\.length\b/.test(codigo)) return 'tamanho';
  if (/\bjson\b|\bcsv\b|\bJSON\./.test(codigo)) return 'dados';
  if (/\bmath\b|\bsum\(|\bstatistics\b|\bround\(|\bMath\./.test(codigo)) return 'contas';
  return 'calculo';
}

/** A regra do motor pelo que faz (a "description" do pedido; várias regras podem vir juntas). */
export function acaoDaRegra(descricao: string | null | undefined): { acao: AcaoDoComando; risco: Risco | null } | null {
  const d = String(descricao ?? '');
  if (!d.trim()) return null;
  for (const [re, acao, risco] of REGRAS) if (re.test(d)) return { acao, risco };
  return null;
}

export interface EntradaDoCartao {
  agente: string;
  comando: string;
  /** a "description" do pedido do motor (o nome da regra de perigo, em inglês): só serve para classificar */
  descricao?: string | null;
  /** o motivo que o agente deu, se o motor um dia mandar */
  motivo?: string | null;
  /** a etapa ou o card em que a execução está */
  contexto?: string | null;
}
export interface CartaoDeAprovacao {
  /** a frase do cartão, em código (a tela traduz) */
  resumo_t: Texto;
  /** a mesma frase em português (o texto do cartão e dos canais) */
  resumo: string;
  risco: Risco | null;
  risco_t: Texto | null;
  /** o comando, sem os caminhos internos do motor: só para "Ver detalhes técnicos" */
  detalhe: string;
}

const curto = (s: string | null | undefined, max: number): string => {
  const t = limparCaminhos(String(s ?? '')).replace(/\s+/g, ' ').trim().replace(/[.:;,\s]+$/, '');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
/** um texto que parece código não vira motivo nem contexto (o cartão nunca mostra código) */
const pareceCodigo = (s: string): boolean => /[{}<>;=`$|\\]|\b(?:import|print|def|EOF|python3?|node|bash)\b|\/\w/.test(s);

/** O cartão de um comando para aprovar: a frase, o risco e o detalhe técnico. */
export function cartaoDeAprovacao(e: EntradaDoCartao): CartaoDeAprovacao {
  const comando = String(e.comando ?? '');
  const regra = acaoDaRegra(e.descricao);
  const programa = programaDoComando(comando);
  let acao: AcaoDoComando = regra?.acao ?? 'comando';
  // sem regra conhecida, o próprio comando diz o que é
  if (!regra) {
    if (programa?.linguagem) acao = 'programa';
    else if (INSTALA.test(comando)) acao = 'instalar';
    else if (APAGA.test(comando)) acao = 'apagar';
    else if (BAIXA.test(comando)) acao = 'baixar';
  }
  const risco = riscoDoComando(comando, regra?.risco ?? null);
  const linguagem = programa?.linguagem ?? null;
  const acaoT = acao === 'programa' && linguagem
    ? tx('proposta.aprovacao.acao.programaEm', { linguagem })
    : tx(`proposta.aprovacao.acao.${acao}` as Codigo);
  const motivo = e.motivo && !pareceCodigo(e.motivo) ? curto(e.motivo, 140) : '';
  const contexto = e.contexto && !pareceCodigo(e.contexto) ? curto(e.contexto, 120) : '';
  // para quê: o motivo do agente; senão, o que o programa faz (só quando ele só calcula: o resto não dá para dizer)
  const objetivo: string | Texto | null = motivo ? motivo.charAt(0).toLowerCase() + motivo.slice(1)
    : risco === 'calcula' && programa ? tx(`proposta.aprovacao.obj.${objetivoDoPrograma(semTextos(programa.codigo))}` as Codigo) : null;
  const agente = curto(e.agente, 60) || 'O agente';
  const resumo_t = objetivo && contexto ? tx('proposta.aprovacao.querParaNoTrabalho', { agente, acao: acaoT, objetivo, contexto })
    : objetivo ? tx('proposta.aprovacao.querPara', { agente, acao: acaoT, objetivo })
    : contexto ? tx('proposta.aprovacao.querNoTrabalho', { agente, acao: acaoT, contexto })
    : tx('proposta.aprovacao.quer', { agente, acao: acaoT });
  const risco_t = risco ? tx(`proposta.aprovacao.risco.${risco}` as Codigo) : null;
  return { resumo_t, resumo: emPt(resumo_t), risco, risco_t, detalhe: limparCaminhos(comando).trim() };
}

/**
 * O cartão salvo antes desta versão (o resumo levava a regra do motor e o comando inteiro: "Hipátia quer rodar um comando
 * que pede a sua aprovação (script execution via -e/-c flag):\n<comando>"): a frase nova, para os canais e as listas que
 * só têm o resumo. O que não é desse formato fica como está.
 */
const ANTIGO = /^(.{1,80}?) quer rodar um comando que pede a sua aprovação(?: \(([^\n]*)\))?:\n([\s\S]*)$/;
export function resumoVisivelDaAprovacao(summary: string): string {
  const m = ANTIGO.exec(String(summary ?? ''));
  return m ? cartaoDeAprovacao({ agente: m[1], descricao: m[2] ?? '', comando: m[3] }).resumo : summary;
}

/** O payload gravado do cartão (aprovacoes.ts): o que a tela recebe ao lado do resumo. */
export interface PayloadDaAprovacao { agente?: string; comando?: string; descricao?: string; contexto?: string | null; motivo?: string | null; envio?: boolean }
export function vistaDaAprovacao(payload: string | null | undefined): Pick<CartaoDeAprovacao, 'resumo' | 'resumo_t' | 'risco_t' | 'detalhe'> & { risco: string | null } | null {
  let x: PayloadDaAprovacao;
  try { x = JSON.parse(payload ?? '') as PayloadDaAprovacao; } catch { return null; }
  if (!x || typeof x !== 'object' || x.envio || typeof x.comando !== 'string') return null;
  const c = cartaoDeAprovacao({ agente: x.agente ?? '', comando: x.comando, descricao: x.descricao, contexto: x.contexto, motivo: x.motivo });
  return { ...c, risco: c.risco_t ? emPt(c.risco_t) : null };
}
