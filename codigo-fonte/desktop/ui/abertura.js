// Tela de abertura: pede o diagnóstico ao aplicativo, mostra o estado em palavras (nada de percentual inventado),
// oferece as ações que fazem sentido e abre o Ergon quando ele está pronto e confirmado.
'use strict';
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const ROTULOS = {
  abrir: 'Abrir o Ergon', iniciar: 'Iniciar Ergon', tentar: 'Tentar novamente', navegador: 'Abrir no navegador',
  diagnostico: 'Ver diagnóstico', 'ajuda:docker': 'Como instalar o Docker', 'ajuda:docker_rootless': 'Docker sem root (recomendado)',
  'ajuda:docker_pos_instalacao': 'Outras formas de acesso', 'ajuda:instalar_ergon': 'Como instalar o Ergon',
};
const PRINCIPAIS = new Set(['abrir', 'iniciar']);
let ultimo = null;
let esperando = null;

function fase(texto, atencao = false) {
  $('fase').textContent = texto;
  $('fase').classList.toggle('is-atencao', atencao);
}
// carregando, o emblema animado ocupa o lugar do logo (a marca aparece uma vez só)
function carregando(sim) { $('carregando').hidden = !sim; $('logo').hidden = sim; }
function linha(t) { $('linha').textContent = t || ''; }

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
  fase(d.estado === 'pronto' ? 'Pronto' : d.estado === 'iniciando' ? 'Iniciando Ergon' : 'Necessita atenção', !['pronto', 'iniciando'].includes(d.estado));
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
  if (location.hash === '#iniciar') {
    history.replaceState(null, '', location.pathname);
    if (d.acoes.includes('iniciar')) agir('iniciar');
  }
}

async function agir(a, botao) {
  try {
    if (a === 'abrir') { fase('Pronto'); await invoke('abrir_ergon'); }
    else if (a === 'tentar') await verificar();
    else if (a === 'navegador') await invoke('abrir_no_navegador');
    else if (a === 'diagnostico') { const s = $('diagnostico'); s.hidden = !s.hidden; }
    else if (a.startsWith('ajuda:')) await invoke('abrir_ajuda', { tema: a.slice(6) });
    else if (a === 'iniciar') {
      if (botao) botao.disabled = true;
      carregando(true); fase('Preparando ambiente');
      $('titulo').textContent = 'Iniciando o Ergon…';
      $('texto').textContent = 'Ligando os serviços locais. Na primeira vez do dia o Docker pode levar alguns minutos.';
      botoes([]);
      await invoke('subir_servicos');
    }
  } catch (e) {
    carregando(false); fase('Necessita atenção', true);
    $('texto').textContent = String(e);
    botoes(ultimo ? ultimo.acoes : ['tentar']);
  }
}

// o lançador fala linha a linha: a fase acompanha o que ele está fazendo
listen('servicos:linha', ({ payload }) => {
  const t = String(payload);
  linha(t);
  const l = t.toLowerCase();
  if (l.includes('docker')) fase('Preparando ambiente');
  else if (l.includes('hermes') || l.includes('motor')) fase('Iniciando motor de IA');
  else fase('Iniciando Ergon');
});
listen('servicos:fim', ({ payload }) => {
  linha('');
  if (payload.ok) { verificar(); return; }
  carregando(false); fase('Necessita atenção', true);
  $('titulo').textContent = 'O Ergon não iniciou';
  $('texto').textContent = payload.mensagem || 'O lançador terminou com erro.';
  botoes(['tentar', 'diagnostico', 'navegador']);
});

$('registros').addEventListener('click', () => invoke('abrir_registros').catch(() => {}));
verificar();
