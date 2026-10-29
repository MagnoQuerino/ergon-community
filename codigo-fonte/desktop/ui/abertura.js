// Tela de abertura: pede o diagnóstico ao aplicativo, mostra o estado em palavras, oferece as ações que fazem sentido
// e abre o Ergon quando ele está pronto e confirmado. Instalando ou ligando, a espera fala a língua da cidade: cada
// etapa técnica tem as suas frases (nós sabemos em que passo está; a pessoa aproveita a viagem), e o registro técnico
// fica guardado no diagnóstico, para quem precisar.
'use strict';
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const ROTULOS = {
  abrir: 'Abrir o Ergon', iniciar: 'Iniciar Ergon', instalar: 'Começar', tentar: 'Tentar novamente', navegador: 'Abrir no navegador',
  diagnostico: 'Ver diagnóstico', 'ajuda:docker': 'Como instalar o Docker', 'ajuda:docker_rootless': 'Docker sem root (recomendado)',
  'ajuda:docker_pos_instalacao': 'Outras formas de acesso', 'ajuda:instalar_ergon': 'Como instalar o Ergon',
  atualizar: 'Atualizar agora', voltar: 'Voltar ao Ergon', verificar: 'Verificar de novo',
};
const PRINCIPAIS = new Set(['abrir', 'iniciar', 'instalar', 'atualizar']);
// etapas de uma atualização (a barra acompanha estas; a instalação usa ORDEM)
const ORDEM_ATUALIZAR = ['diagnostico', 'backup', 'baixar', 'configurar', 'ligar', 'conferir', 'aplicativo'];
const SEGURANCA = 'Esta atualização traz revisões de segurança que precisam ser aplicadas para prevenir riscos ao ambiente do Ergon. Até atualizar, o Ergon fica bloqueado.';
// etapa técnica → frases da cidade (a ordem das etapas dá o avanço da barra)
const ORDEM = ['diagnostico', 'wsl', 'baixar', 'importar', 'configurar', 'ligar', 'conferir'];
// uma frase por etapa (sorteada destas): quem instala vê uma frase nova a cada passo real, sem roda de frases
const FRASES = {
  diagnostico: ['Consultando o oráculo de Delfos sobre este computador…', 'Medindo o terreno onde a cidade vai nascer…', 'Os agrimensores fincam as primeiras estacas…', 'Pítia interpreta os sinais deste computador…'],
  wsl: ['Abrindo os portões da cidade…', 'Pedindo licença aos deuses do Olimpo (se o Windows perguntar, pode aceitar)…', 'Os guardiões preparam a muralha…'],
  baixar: ['Reunindo os pergaminhos que sobraram de Alexandria…', 'Trazendo mármore das pedreiras do Pentélico…', 'Enchendo as ânforas para a viagem…', 'Os navios chegam ao porto de Pireu, carregados…', 'Conferindo cada pergaminho, um por um, para nada chegar rasgado…', 'Uma caravana atravessa o Egeu com tudo de que a cidade precisa…'],
  importar: ['Levantando as colunas da Stoa…', 'Traçando as ruas da nova cidade…', 'Assentando a primeira pedra da ágora…', 'Erguendo os muros da biblioteca…'],
  configurar: ['Gravando as leis da cidade em tábuas de bronze…', 'Guardando as chaves do tesouro no templo…', 'Sólon revisa as leis antes de publicá-las…', 'Selando os cofres com cera e anel…'],
  ligar: ['Acendendo o farol de Alexandria…', 'Tentando tirar Sócrates de um diálogo interminável na feira de Atenas…', 'Aristóteles organiza as anotações do Liceu…', 'Os filósofos estão chegando à ágora…', 'Acendendo as lamparinas da Stoa…'],
  backup: ['Copiando os pergaminhos para a biblioteca de reserva…', 'Guardando uma cópia de tudo no cofre do templo…'],
  aplicativo: ['Trocando as portas da cidade por portas novas…', 'O mestre de obras assina a reforma…'],
  conferir: ['Hipátia confere os cálculos uma última vez…', 'Abrindo as portas da ágora…', 'Arquimedes testa as alavancas da cidade…', 'Os arautos anunciam: a cidade está de pé…'],
};
const ACORDANDO = ['Acordando a cidade…', 'Os filósofos estão chegando à ágora…', 'Acendendo as lamparinas da Stoa…', 'Sócrates já começou a fazer perguntas…', 'Abrindo as janelas da biblioteca…'];

let instalando = false;
let ultimo = null;
let esperando = null;
let verificado = false;
let atualizando = false;
let ordemAtual = ORDEM;
const registro = [];

function fase(texto, atencao = false) {
  $('fase').textContent = texto;
  $('fase').classList.toggle('is-atencao', atencao);
}
// carregando, o emblema animado ocupa o lugar do logo (a marca aparece uma vez só)
function carregando(sim) { $('carregando').hidden = !sim; $('logo').hidden = sim; }
function anotar(t) { if (t) { registro.push(t); if (registro.length > 400) registro.shift(); } }

// uma frase sorteada da lista, escrita letra a letra uma vez e parada até a próxima etapa; com "menos movimento" no
// sistema, aparece inteira
const calmo = matchMedia('(prefers-reduced-motion: reduce)').matches;
let roda = null;
function frases(lista) {
  clearTimeout(roda);
  const el = $('frase');
  if (!lista || !lista.length) { el.textContent = ''; return; }
  const f = lista[Math.floor(Math.random() * lista.length)];
  if (calmo) { el.textContent = f; return; }
  let n = 0;
  const passo = () => { el.textContent = f.slice(0, n); if (n++ < f.length) roda = setTimeout(passo, 28); };
  passo();
}
// barra: etapas concluídas + a fração do download na etapa "baixar" (sem percentual escrito)
let etapaAtual = -1;
function barra(fracao) {
  if (etapaAtual < 0) { $('barra').hidden = true; return; }
  const v = Math.min(100, Math.round(((etapaAtual + (fracao ?? 0)) / ordemAtual.length) * 100));
  $('barra').hidden = false;
  $('barra').setAttribute('aria-valuenow', String(v));
  $('barra-cheia').style.width = `${Math.max(4, v)}%`;
}

function botoes(acoes) {
  const box = $('acoes');
  box.replaceChildren();
  for (const a of acoes) {
    if (!ROTULOS[a]) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `botao ${PRINCIPAIS.has(a) ? 'botao--principal' : ''}`;
    b.textContent = ROTULOS[a];
    b.addEventListener('click', () => agir(a, b));
    box.append(b);
  }
  box.querySelector('button')?.focus();
}

function mostrar(d) {
  ultimo = d;
  $('titulo').textContent = d.titulo;
  $('texto').textContent = d.explicacao;
  const avisos = $('avisos');
  avisos.replaceChildren(...d.avisos.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  avisos.hidden = !d.avisos.length;
  $('detalhes').replaceChildren(...d.detalhes.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  carregando(d.estado === 'iniciando');
  const convite = d.estado === 'nao_instalado' && d.acoes.includes('instalar');
  fase(d.estado === 'pronto' ? 'Pronto' : d.estado === 'iniciando' ? 'Iniciando Ergon' : convite ? '' : 'Necessita atenção', !['pronto', 'iniciando'].includes(d.estado) && !convite);
  frases(d.estado === 'iniciando' ? ACORDANDO : null);
  botoes(d.acoes);
}

async function verificar() {
  clearTimeout(esperando);
  carregando(true);
  fase('Verificando serviços');
  let d;
  try { d = await invoke('diagnosticar'); } catch (e) {
    carregando(false); fase('Necessita atenção', true);
    $('titulo').textContent = 'Não foi possível verificar o Ergon'; $('texto').textContent = String(e);
    botoes(['tentar']); return;
  }
  const primeira = !verificado; verificado = true; ultimo = d;
  if (d.estado === 'pronto' && d.confirmado && !d.avisos.length) {
    // atualização de segurança obrigatória publicada: bloqueia antes de abrir (sem rede, segue: nada é obrigatório
    // sem o manifesto conferido)
    const u = await situacaoAtualizacao(8000);
    if (u && u.nova && u.obrigatoria) { telaSeguranca(u); return; }
    // pronto e confirmado: abre direto, sem mostrar uma tela com botão que some em seguida. O "Abrir" só aparece
    // se a janela não trocar em alguns segundos.
    carregando(true); fase('Pronto'); frases(['A cidade está pronta. Bem-vindo à ágora!']);
    agir('abrir');
    esperando = setTimeout(() => mostrar(d), 6000);
    return;
  }
  // ao abrir o app com o ambiente desligado: liga direto (abrir o Ergon é querer o Ergon ligado)
  if (primeira && d.estado === 'parado' && d.acoes.includes('iniciar') && !d.avisos.length) { agir('iniciar'); return; }
  // depois de reiniciar o Windows, a instalação continua sozinha (direto, sem mostrar o convite antes)
  if (d.continuar && d.acoes.includes('instalar')) { agir('instalar'); return; }
  mostrar(d);
  if (d.estado === 'iniciando') {
    esperando = setTimeout(verificar, 3000);
  }
  if (location.hash === '#iniciar') {
    history.replaceState(null, '', location.pathname);
    if (d.acoes.includes('iniciar')) agir('iniciar');
  }
}

function mostrarRegistro() {
  $('registro').textContent = registro.join('\n');
  $('registro-box').hidden = !registro.length;
}

async function agir(a, botao) {
  try {
    if (a === 'abrir') { fase('Pronto'); frases(['A cidade está pronta. Bem-vindo à ágora!']); await invoke('abrir_ergon'); }
    else if (a === 'tentar' || a === 'voltar') await verificar();
    else if (a === 'verificar') await telaAtualizacoes();
    else if (a === 'atualizar') {
      if (botao) botao.disabled = true;
      atualizando = true; registro.length = 0; ordemAtual = ORDEM_ATUALIZAR; etapaAtual = 0;
      carregando(true); fase('Atualizando o Ergon');
      $('titulo').textContent = 'Reformando a cidade…';
      $('texto').textContent = 'Primeiro uma cópia dos seus dados, depois a versão nova. Leva alguns minutos; se algo der errado, a versão de antes volta sozinha.';
      $('avisos').hidden = true;
      frases(FRASES.diagnostico); barra(0);
      botoes([]);
      await invoke('atualizar_ergon');
    }
    else if (a === 'navegador') await invoke('abrir_no_navegador');
    else if (a === 'diagnostico') { mostrarRegistro(); const s = $('diagnostico'); s.hidden = !s.hidden; }
    else if (a.startsWith('ajuda:')) await invoke('abrir_ajuda', { tema: a.slice(6) });
    else if (a === 'instalar') {
      if (botao) botao.disabled = true;
      instalando = true; registro.length = 0; etapaAtual = 0;
      carregando(true); fase('Preparando a cidade');
      $('titulo').textContent = 'Erguendo a sua cidade…';
      $('texto').textContent = 'Leva alguns minutos. Pode deixar aberto e fazer outra coisa: se a internet cair, continuamos de onde parou.';
      frases(FRASES.diagnostico); barra(0);
      botoes([]);
      await invoke('instalar_ergon');
    }
    else if (a === 'iniciar') {
      if (botao) botao.disabled = true;
      registro.length = 0;
      carregando(true); fase('Iniciando Ergon');
      $('titulo').textContent = 'Acordando a cidade…';
      $('texto').textContent = 'Na primeira vez do dia pode levar alguns minutos.';
      frases(ACORDANDO);
      botoes([]);
      await invoke('subir_servicos');
    }
  } catch (e) {
    carregando(false); fase('Necessita atenção', true); frases(null); etapaAtual = -1; barra();
    $('texto').textContent = String(e);
    botoes(ultimo ? ultimo.acoes : ['tentar']);
  }
}

// a instalação avisa cada etapa técnica: a frase e a barra acompanham; o texto técnico vai para o registro
listen('instalacao:etapa', ({ payload }) => {
  anotar(`ETAPA ${payload}`);
  const i = ordemAtual.indexOf(payload);
  if (i >= 0) { etapaAtual = i; barra(0); }
  frases(FRASES[payload] || FRASES.ligar);
});
listen('instalacao:progresso', ({ payload: [c, feitos, total] }) => {
  if (total > 0 && ['baixar', 'aplicativo'].includes(ordemAtual[etapaAtual])) barra(feitos / total);
  if (feitos === total) anotar(`${c}: ${(total / 1e6).toFixed(1)} MB conferidos`);
});
listen('instalacao:reiniciar', () => {
  instalando = false; carregando(false); fase('Reinicie o Windows', true); frases(null); etapaAtual = -1; barra();
  $('titulo').textContent = 'O Windows precisa reiniciar';
  $('texto').textContent = 'Salve o que estiver aberto e reinicie o computador. Depois o Ergon abre sozinho e continua de onde parou.';
  botoes([]);
});
listen('servicos:linha', ({ payload }) => {
  const t = String(payload);
  anotar(t);
  if (instalando) return;
  const l = t.toLowerCase();
  if (l.includes('docker')) fase('Preparando ambiente');
  else if (l.includes('hermes') || l.includes('motor')) fase('Iniciando motor de IA');
  else fase('Iniciando Ergon');
});
listen('servicos:fim', ({ payload }) => {
  if (payload.mensagem === 'REINICIAR') return;
  if (atualizando) {
    atualizando = false; ordemAtual = ORDEM;
    if (payload.ok) { etapaAtual = ORDEM_ATUALIZAR.length - 1; barra(1); if (!appTrocando) verificar(); return; }
    carregando(false); fase('Atualização não concluída', true); frases(null); etapaAtual = -1; barra();
    $('titulo').textContent = 'A atualização parou';
    $('texto').textContent = payload.mensagem || 'A atualização terminou com erro.';
    mostrarRegistro();
    botoes(ultimoObrigatorio ? ['atualizar', 'diagnostico'] : ['atualizar', 'voltar', 'diagnostico']);
    return;
  }
  const eraInstalacao = instalando; instalando = false;
  if (payload.ok) { if (eraInstalacao) { etapaAtual = ordemAtual.length - 1; barra(1); } verificar(); return; }
  carregando(false); fase('Necessita atenção', true); frases(null); etapaAtual = -1; barra();
  $('titulo').textContent = eraInstalacao ? 'A instalação parou' : 'O Ergon não iniciou';
  $('texto').textContent = payload.mensagem || 'O lançador terminou com erro.';
  mostrarRegistro();
  botoes(eraInstalacao ? ['instalar', 'diagnostico'] : ['tentar', 'diagnostico', 'navegador']);
});

let appTrocando = false;
let ultimoObrigatorio = false;
listen('atualizacao:aplicativo', ({ payload }) => {
  appTrocando = true;
  fase('Instalando o aplicativo novo'); frases(FRASES.aplicativo);
  $('titulo').textContent = `Ergon ${payload} pronto`;
  $('texto').textContent = 'O aplicativo novo está se instalando: esta janela fecha e o Ergon reabre sozinho em instantes.';
});

/** Situação das atualizações (manifesto conferido pelo aplicativo); sem resposta no prazo, null (o Ergon segue). */
async function situacaoAtualizacao(prazo) {
  try { return await Promise.race([invoke('verificar_atualizacao'), new Promise((ok) => setTimeout(() => ok(null), prazo))]); }
  catch { return null; }
}

/** Atualização de segurança obrigatória: o uso fica bloqueado; a única saída é atualizar. */
function telaSeguranca(u) {
  ultimoObrigatorio = true;
  carregando(false); fase('Atualização de segurança', true); frases(null); etapaAtual = -1; barra();
  $('titulo').textContent = `Atualização de segurança: Ergon ${u.nova}`;
  $('texto').textContent = SEGURANCA;
  const av = $('avisos');
  av.replaceChildren(...(u.motivo ? [Object.assign(document.createElement('li'), { textContent: u.motivo })] : []));
  av.hidden = !u.motivo;
  botoes(u.podeAtualizar ? ['atualizar', 'diagnostico'] : ['diagnostico']);
  if (!u.podeAtualizar) $('texto').textContent = `${SEGURANCA} Nesta instalação, baixe e instale a versão nova pela página de lançamentos.`;
}

/** "Verificar atualizações" (pedido pela página do Ergon ou daqui): confere e oferece atualizar, sem pressa. */
async function telaAtualizacoes() {
  clearTimeout(esperando);
  carregando(true); fase('Verificando atualizações'); frases(['Consultando os arautos sobre novidades…']);
  $('titulo').textContent = 'Atualizações'; $('texto').textContent = ''; $('avisos').hidden = true; botoes([]);
  const u = await situacaoAtualizacao(20000);
  carregando(false); frases(null);
  if (!u) { fase('Sem resposta', true); $('texto').textContent = 'Não deu para verificar agora. O Ergon segue como está.'; botoes(['verificar', 'voltar']); return; }
  if (u.nova && u.obrigatoria) { telaSeguranca(u); return; }
  ultimoObrigatorio = false;
  if (u.erro) { fase('Sem resposta', true); $('texto').textContent = `${u.erro} O Ergon segue como está.`; botoes(['verificar', 'voltar']); return; }
  if (!u.nova) { fase('Em dia'); $('titulo').textContent = `Ergon ${u.atual}`; $('texto').textContent = 'Você está na versão mais recente.'; botoes(['voltar', 'verificar']); return; }
  fase('Versão nova');
  $('titulo').textContent = `Ergon ${u.nova} disponível`;
  $('texto').textContent = u.podeAtualizar
    ? `Você está na ${u.atual}. Atualizar é opcional: faz uma cópia dos seus dados antes e, se algo der errado, a versão de antes volta sozinha.`
    : `Você está na ${u.atual}. Nesta instalação, baixe e instale a versão nova pela página de lançamentos.`;
  botoes(u.podeAtualizar ? ['atualizar', 'voltar'] : ['voltar']);
}

$('registros').addEventListener('click', () => invoke('abrir_registros').catch(() => {}));
addEventListener('hashchange', () => { if (location.hash === '#atualizacoes') telaAtualizacoes(); });
if (location.hash === '#atualizacoes') telaAtualizacoes(); else verificar();
