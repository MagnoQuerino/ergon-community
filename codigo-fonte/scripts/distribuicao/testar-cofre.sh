#!/usr/bin/env bash
# Teste do cofre do motor de IA no Podman, com a especificação do gerente de motores desta versão
# (server/src/services/motor-manager.ts): volume do cofre, tmpfs só em memória para a vista aberta, /dev/fuse e só o
# privilégio de montar. Faz o que a imagem do motor faz (hermes/vault/ergon-vault.py): o cofre é criado e montado pelo
# usuário do motor (10000); um arquivo gravado na vista aberta tem de voltar igual e chegar cifrado ao volume.
#   testar-cofre.sh <imagem do motor> [podman]
set -u
IMG="$1"; P="${2:-podman}"
V="ergon-teste-cofre-$$"
"$P" volume create "$V" > /dev/null
SCRIPT='set -e
chown 10000:10000 /vault /opt/data
umask 077; printf "chave-de-teste-do-cofre" > /tmp/k; chown 10000:10000 /tmp/k
como() { setpriv --reuid=10000 --regid=10000 --clear-groups --inh-caps=+sys_admin --ambient-caps=+sys_admin "$@"; }
como gocryptfs -q -nosyslog -init -passfile /tmp/k /vault
como gocryptfs -q -nosyslog -allow_other -nonempty -passfile /tmp/k /vault /opt/data
como sh -c "echo conteudo-do-cofre > /opt/data/teste && cat /opt/data/teste"
echo "cifrados: $(find /vault -type f | wc -l)"
grep -rl conteudo-do-cofre /vault >/dev/null 2>&1 && echo "ABERTO-NO-VOLUME" || echo "volume-so-cifrado"'
"$P" run --rm --entrypoint sh \
  --mount "type=volume,source=$V,target=/vault" --tmpfs /opt/data:mode=0700 \
  --device /dev/fuse --cap-add SYS_ADMIN --cap-drop NET_RAW --cap-drop MKNOD --cap-drop AUDIT_WRITE --cap-drop SETFCAP \
  --security-opt no-new-privileges "$IMG" -c "$SCRIPT"
r=$?
"$P" volume rm -f "$V" > /dev/null 2>&1
exit $r
