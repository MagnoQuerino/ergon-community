# Ergon MVP local — imagem única com API (Node + Fastify) e frontend compilado.
# Base fixada por versão e digest (Node 24 LTS).
ARG NODE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

# Manifestos das dependências SEM o número da versão: trocar só a versão não refaz (nem faz baixar de novo) a camada
# das dependências. Os package.json de verdade entram depois, numa camada de poucos bytes.
FROM ${NODE_IMAGE} AS manifestos
WORKDIR /m
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN node -e "const fs=require('fs'),w=(f,o)=>fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n');for(const f of ['package.json','server/package.json','web/package.json']){const p=JSON.parse(fs.readFileSync(f));p.version='0.0.0';w(f,p)}const l=JSON.parse(fs.readFileSync('package-lock.json'));l.version='0.0.0';for(const k of ['','server','web'])l.packages[k].version='0.0.0';w('package-lock.json',l)"

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=manifestos /m ./
# Sem scripts de instalação: o SQLite cifrado já traz o binário pronto por plataforma (nada é compilado)
# e os demais scripts só conferem versão.
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM deps AS build
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY shared shared
COPY server server
COPY web web
RUN npm run typecheck -w server && npm run build -w web

# Alvo de testes: docker build --target test .
FROM build AS test
COPY fixtures fixtures
RUN npm test -w server && npm test -w web

FROM ${NODE_IMAGE} AS runtime
# commit da versão publicada (gravado pela esteira de lançamento; "dev" em builds locais)
ARG ERGON_BUILD=dev
ENV NODE_ENV=production \
    ERGON_BUILD=${ERGON_BUILD} \
    ERGON_HOST=0.0.0.0 \
    ERGON_PORT=8787 \
    ERGON_DATA_DIR=/data \
    ERGON_WEB_DIR=/app/web/dist \
    ERGON_FIXTURES_DIR=/app/fixtures
WORKDIR /app
COPY --from=manifestos /m ./
# sem o cache e os registros datados do npm (deixavam a camada diferente a cada build da mesma fonte)
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && rm -rf /root/.npm /tmp/* node_modules/.package-lock.json
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY shared shared
COPY server/src server/src
COPY server/catalogo server/catalogo
COPY fixtures fixtures
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/src/index.ts"]
