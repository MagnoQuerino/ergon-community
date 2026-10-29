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
};
const PRINCIPAIS = new Set(['abrir', 'iniciar', 'instalar']);
// etapa técnica → frases da cidade (a ordem das etapas dá o avanço da barra)
const ORDEM = ['diagnostico', 'wsl', 'baixar', 'importar', 'configurar', 'ligar', 'conferir'];
const FRASES = {
  diagnostico: ['Consultando o oráculo de Delfos sobre este computador…', 'Medindo o terreno onde a cidade vai nascer…'],
  wsl: ['Abrindo os portões da cidade…', 'Pedindo licença aos deuses do Olimpo (se o Windows perguntar, pode aceitar)…'],
  baixar: ['Reunindo os pergaminhos que sobraram de Alexandria…', 'Trazendo mármore das pedreiras do Pentélico…', 'Enchendo as ânforas para a viagem…', 'Conferindo cada pergaminho, um por um, para nada chegar rasgado…'],
  importar: ['Levantando as colunas da Stoa…', 'Traçando as ruas da nova cidade…'],
  configurar: ['Gravando as leis da cidade em tábuas de bronze…', 'Guardando as chaves do tesouro no templo…'],
  ligar: ['Acendendo o farol de Alexandria…', 'Tentando tirar Sócrates de um diálogo interminável na feira de Atenas…', 'Aristóteles organiza as anotações do Liceu…', 'Os filósofos estão chegando à ágora…'],
  conferir: ['Hipátia confere os cálculos uma última vez…', 'Abrindo as portas da ágora…'],
};
const ACORDANDO = ['Acordando a cidade…', 'Os filósofos estão chegando à ágora…', 'Acendendo as lamparinas da Stoa…', 'Sócrates já começou a fazer perguntas…'];

let instalando = false;
let ultimo = null;
let esperando = null;
const registro = [];

function fase(texto, atencao = false) {
  $('fase').textContent = texto;
  $('fase').classList.toggle('is-atencao', atencao);
}
// carregando, o emblema animado ocupa o lugar do logo (a marca aparece uma vez só)
function carregando(sim) { $('carregando').hidden = !sim; $('logo').hidden = sim; }
function anotar(t) { if (t) { registro.push(t); if (registro.length > 400) registro.shift(); } }

// frases que se escrevem letra a letra e se revezam; com "menos movimento" no sistema, aparecem inteiras
const calmo = matchMedia('(prefers-reduced-motion: reduce)').matches;
let roda = null;
function frases(lista) {
  clearTimeout(roda);
  const el = $('frase');
  if (!lista || !lista.length) { el.textContent = ''; return; }
  let i = 0; let n = 0;
  const passo = () => {
    const f = lista[i % lista.length];
    if (calmo) { el.textContent = f; i++; roda = setTimeout(passo, 4200); return; }
    if (n <= f.length) { el.textContent = f.slice(0, n); n++; roda = setTimeout(passo, 28); return; }
    i++; n = 0; roda = setTimeout(passo, 2600);
  };
  passo();
}
// barra: etapas concluídas + a fração do download na etapa "baixar" (sem percentual escrito)
let etapaAtual = -1;
function barra(fracao) {
  if (etapaAtual < 0) { $('barra').hidden = true; return; }
  const v = Math.min(100, Math.round(((etapaAtual + (fracao ?? 0)) / ORDEM.length) * 100));
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
  mostrar(d);
  if (d.estado === 'pronto' && d.confirmado && !d.avisos.length) {
    // pronto e confirmado: abre sozinho (o "Abrir" continua lá se algo segurar)
    setTimeout(() => agir('abrir'), 350);
  } else if (d.estado === 'iniciando') {
    esperando = setTimeout(verificar, 3000);
  }
  // depois de reiniciar o Windows, a instalação continua sozinha
  if (d.continuar && d.acoes.includes('instalar')) agir('instalar');
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
    else if (a === 'tentar') await verificar();
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
  const i = ORDEM.indexOf(payload);
  if (i >= 0) { etapaAtual = i; barra(0); }
  frases(FRASES[payload] || FRASES.ligar);
});
listen('instalacao:progresso', ({ payload: [c, feitos, total] }) => {
  if (total > 0 && ORDEM[etapaAtual] === 'baixar') barra(feitos / total);
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
  const eraInstalacao = instalando; instalando = false;
  if (payload.ok) { if (eraInstalacao) { etapaAtual = ORDEM.length - 1; barra(1); } verificar(); return; }
  carregando(false); fase('Necessita atenção', true); frases(null); etapaAtual = -1; barra();
  $('titulo').textContent = eraInstalacao ? 'A instalação parou' : 'O Ergon não iniciou';
  $('texto').textContent = payload.mensagem || 'O lançador terminou com erro.';
  mostrarRegistro();
  botoes(eraInstalacao ? ['instalar', 'diagnostico'] : ['tentar', 'diagnostico', 'navegador']);
});

$('registros').addEventListener('click', () => invoke('abrir_registros').catch(() => {}));
verificar();
