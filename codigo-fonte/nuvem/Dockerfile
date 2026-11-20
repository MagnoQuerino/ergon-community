# Nuvem do Ergon World: o Ergon e o motor de IA numa imagem só (um contêiner e um isolamento gVisor por cliente, em vez
# de dois). Montada a partir das duas imagens da MESMA versão, sem compilar nada: o app vem inteiro da imagem do Ergon e
# roda com o Node dela; o motor é a imagem do motor como está. O supervisor (partida.py) inicia os dois, cada um com o
# próprio usuário, disco e ambiente. Só a nuvem usa esta imagem; o Ergon local continua com as duas separadas.
ARG APP_IMAGE=ergon-app:dev
ARG MOTOR_IMAGE=ergon-hermes:dev
FROM ${APP_IMAGE} AS app

FROM ${MOTOR_IMAGE}
ARG ERGON_BUILD=dev
USER root
COPY --from=app /usr/local/bin/node /usr/local/bin/node
COPY --from=app /app /app
COPY partida.py /usr/local/lib/ergon/partida.py
# a imagem não é construída se o Node não rodar na base do motor ou faltar o app. O segredo do app do Google (se a
# imagem do Ergon o trouxer) fica só para o usuário do app: o motor e os agentes não o leem
RUN node --version \
 && test -f /app/server/src/index.ts && test -d /app/web/dist && test -d /app/node_modules \
 && /opt/hermes/.venv/bin/python -c "import ast; ast.parse(open('/usr/local/lib/ergon/partida.py').read())" \
 && mkdir -p /data && chown 1000:1000 /data && chmod 700 /data \
 && if [ -e /app/google-app.secret ]; then chown 1000:1000 /app/google-app.secret && chmod 400 /app/google-app.secret; fi
ENV NODE_ENV=production ERGON_BUILD=${ERGON_BUILD} ERGON_HOST=0.0.0.0 ERGON_PORT=8787 ERGON_DATA_DIR=/data ERGON_WEB_DIR=/app/web/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/usr/local/lib/ergon/partida.py"]
CMD []
