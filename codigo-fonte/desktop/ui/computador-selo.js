// O selo "usando este computador" (rc.42): quem está usando, e o botão que assume ou concede o controle. Só fala com o
// aplicativo (computador_assumir, computador_conceder, computador_estado); nenhum dado da pessoa passa por aqui.
(function () {
  'use strict';
  var T = window.__TAURI__;
  var selo = document.getElementById('selo');
  var quem = document.getElementById('quem');
  var frase = document.getElementById('frase');
  var botao = document.getElementById('botao');
  var tecla = document.getElementById('tecla');
  var pausado = false;
  function mostrar(e) {
    if (!e) return;
    pausado = !!e.pausado;
    selo.classList.toggle('is-pessoa', pausado);
    quem.textContent = pausado ? 'Você' : (e.agente || 'Ergon');
    frase.textContent = pausado ? 'está no controle' : 'usando este computador';
    botao.textContent = pausado ? 'Conceder o controle' : 'Assumir o controle';
    tecla.hidden = pausado;
    if (e.panico) tecla.textContent = e.panico;
  }
  botao.addEventListener('click', function () {
    if (!T) return;
    T.core.invoke(pausado ? 'computador_conceder' : 'computador_assumir').catch(function () {});
  });
  if (T) {
    T.event.listen('computador', function (ev) { mostrar(ev.payload); });
    T.core.invoke('computador_estado').then(mostrar).catch(function () {});
  } else {
    // pré-visualização fora do aplicativo (?pessoa=1&agente=Nome)
    var q = new URLSearchParams(location.search);
    mostrar({ pausado: q.get('pessoa') === '1', agente: q.get('agente') || 'Hipátia', panico: 'Ctrl+Alt+Esc' });
  }
})();
