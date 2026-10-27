/**
 * Medição da análise de desempenho: tempo e memória do caminho determinístico
 * (ler CSV → indicadores → relatório → CSV de indicadores), com a planilha da jornada e planilhas sintéticas grandes.
 * Não chama modelo de IA. Uso: node server/scripts/bench-desempenho.ts
 */
import { parseCsv } from '../src/services/csv.ts';
import { analyzePerformance, indicatorsCsv, performanceReport } from '../src/services/ops/desempenho.ts';

const SAMPLE = '﻿ID;Título;Responsável;Prazo original;Prazo vigente;Data de conclusão;Situação\r\n'
  + 'T1;Relatório mensal;Ana;05/10/2026;05/10/2026;04/10/2026;Concluída\r\n'
  + 'T2;"Revisão do contrato\r\ncom o fornecedor";Ana;10/10/2026;15/10/2026;14/10/2026;Concluída\r\n'
  + 'T3;Planilha de custos;Bruno;08/10/2026;08/10/2026;08/10/2026;Concluída\r\n'
  + 'T4;Apresentação;Bruno;12/10/2026;12/10/2026;16/10/2026;Concluída\r\n'
  + 'T5;Treinamento;Carla;20/10/2026;20/10/2026;;Em andamento\r\n'
  + 'T6;Auditoria;Carla;22/10/2026;30/10/2026;;Pendente\r\n';

/** Planilha sintética determinística (sem aleatório): n tarefas, 40 responsáveis, datas de 2026. */
function synthetic(n: number): string {
  const L = ['ID;Título;Responsável;Prazo original;Prazo vigente;Data de conclusão;Situação'];
  const d = (k: number) => { const t = new Date(Date.UTC(2026, 0, 1) + (k % 300) * 86_400_000); return `${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/2026`; };
  for (let i = 0; i < n; i++) {
    const done = i % 3 !== 0;
    L.push(`T${i};Tarefa ${i};Pessoa ${i % 40};${d(i)};${d(i + (i % 7 === 0 ? 5 : 0))};${done ? d(i + (i % 5) - 2) : ''};${done ? 'Concluída' : 'Em andamento'}`);
  }
  return L.join('\r\n') + '\r\n';
}

function measure(label: string, text: string, runs = 5) {
  const buf = Buffer.from(text, 'utf8');
  const times: number[] = [];
  let rows = 0; let peak = 0;
  for (let i = 0; i < runs; i++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const p = analyzePerformance(parseCsv(buf), '2026-10-24');
    const md = performanceReport(p, { pedido: 'bench', tarefa: 1, arquivo: 'bench.csv', sha256: '0'.repeat(64), agente: 'bench', indicadoresArquivo: 'i.csv' });
    const csv = indicatorsCsv(p);
    times.push(performance.now() - t0);
    peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    rows = p.validas;
    if (!md.length || !csv.length) throw new Error('saída vazia');
  }
  times.sort((a, b) => a - b);
  const kb = (n: number) => `${Math.round(n / 1024).toLocaleString('pt-BR')} KB`;
  console.log(`${label.padEnd(26)} arquivo ${kb(buf.length).padStart(9)} · ${String(rows).padStart(7)} linhas · mediana ${times[Math.floor(times.length / 2)].toFixed(1).padStart(8)} ms · pior ${times.at(-1)!.toFixed(1).padStart(8)} ms · heap +${kb(Math.max(0, peak))}`);
}

console.log(`Node ${process.version} · ${process.platform} · sem modelo de IA (só o caminho determinístico)`);
measure('jornada (6 linhas)', SAMPLE, 20);
measure('sintética 10 mil', synthetic(10_000));
measure('sintética 100 mil', synthetic(100_000), 3);
measure('sintética 200 mil (limite)', synthetic(200_000), 2);
