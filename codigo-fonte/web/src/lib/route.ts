import { useEffect, useRef, useState } from 'react';

const readParam = (name: string): string | null => new URLSearchParams(location.hash.split('?')[1] ?? '').get(name);

/**
 * Um parâmetro no fim do endereço (#tarefas?card=tsk_…): o card aberto sobrevive a atualizar a página, e o Voltar do
 * navegador fecha o painel em vez de sair da área. Só identificadores vão para o endereço, nunca conteúdo.
 */
export function useHashParam(name: string): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState(() => readParam(name));
  // a entrada do histórico foi criada por nós ao abrir: fechar volta uma entrada (não deixa um "Voltar" morto)
  const pushed = useRef(false);
  useEffect(() => {
    const on = () => { const v = readParam(name); if (!v) pushed.current = false; setValue(v); };
    addEventListener('popstate', on); addEventListener('hashchange', on);
    return () => { removeEventListener('popstate', on); removeEventListener('hashchange', on); };
  }, [name]);
  const set = (v: string | null) => {
    const [view, q] = location.hash.slice(1).split('?');
    const p = new URLSearchParams(q ?? '');
    if (v) p.set(name, v); else p.delete(name);
    const url = `#${view}${p.toString() ? `?${p}` : ''}`;
    if (v && !readParam(name)) { history.pushState(null, '', url); pushed.current = true; }
    else if (!v && pushed.current) { pushed.current = false; history.back(); }
    else history.replaceState(null, '', url);
    setValue(v);
  };
  return [value, set];
}
