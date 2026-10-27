#!/usr/bin/env node
// Ficha da versão do Ergon Desktop: somas SHA-256 dos pacotes e a compatibilidade (versão do aplicativo, Ergon Core
// mínimo, Tauri, commit). Sai em desktop/pacotes/. Uso: node desktop/scripts/ficha.mjs <plataforma> <arquivos…>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.resolve(import.meta.dirname, '..', '..');
const [plataforma, ...arquivos] = process.argv.slice(2);
if (!plataforma || !arquivos.length) { console.error('uso: ficha.mjs <plataforma> <arquivos…>'); process.exit(1); }

const versao = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version;
const diag = fs.readFileSync(path.join(raiz, 'desktop/src-tauri/src/diag.rs'), 'utf8');
const coreMinimo = /CORE_MINIMO: &str = "([^"]+)"/.exec(diag)?.[1] ?? null;
const lock = fs.readFileSync(path.join(raiz, 'desktop/src-tauri/Cargo.lock'), 'utf8');
const tauri = /name = "tauri"\nversion = "([^"]+)"/.exec(lock)?.[1] ?? null;

const saida = path.join(raiz, 'desktop/pacotes');
fs.mkdirSync(saida, { recursive: true });
const lista = arquivos.map((f) => {
  const dados = fs.readFileSync(f);
  return { nome: path.basename(f), bytes: dados.length, sha256: crypto.createHash('sha256').update(dados).digest('hex') };
});
fs.writeFileSync(path.join(saida, `SHA256SUMS-${plataforma}.txt`), lista.map((a) => `${a.sha256}  ${a.nome}`).join('\n') + '\n');
const ficha = {
  produto: 'Ergon Desktop', versao, plataforma,
  // a janela abre o Ergon Core instalado no computador; abaixo desta versão ela avisa e oferece o navegador
  compatibilidade: { ergonCoreMinimo: coreMinimo, tauri },
  commit: process.env.GITHUB_SHA ?? null, geradoEm: new Date().toISOString(), arquivos: lista,
};
fs.writeFileSync(path.join(saida, `ergon-desktop-${plataforma}.json`), JSON.stringify(ficha, null, 2) + '\n');
console.log(JSON.stringify(ficha, null, 2));
