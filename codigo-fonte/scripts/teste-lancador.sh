#!/usr/bin/env bash
# Teste da limpeza do lançador (ergon.sh) com um Podman simulado: imagens, contêineres e nomes de mentira; nenhuma
# instalação real é tocada. Confere que a limpeza só tira imagens antigas dos repositórios do Ergon, sem forçar, e
# nunca a atual (nem a atual do motor sem contêiner), a de um contêiner, a anterior de um motor ainda não confirmada,
# a de outro projeto ou um volume; que o remover tira todas as do Ergon (as do motor de IA também); que os backups
# giram (ficam os 7 mais recentes, o recém-feito sempre); que das versões guardadas fica só a anterior; e que o
# atualizar chama a limpeza só quando a versão nova está no ar. Por fim, o diagnóstico do motor
# (scripts/distribuicao/diagnostico-motor.sh estado): imagem em uso ao lado da configurada, sem segredo nenhum. E os
# comandos: os nomes novos (em inglês) e os de antes (em português) fazem a mesma coisa; confirmações com s/sim/y/yes e
# APAGAR/DELETE; mensagens em inglês com o sistema em inglês (ou sem idioma dito) e em português com ele em português
# ou dentro do ambiente do Desktop no Windows (ERGON_LANG força); help e version; e o install de um pacote, que copia
# para a pasta do programa e segue pela cópia instalada.
#   bash scripts/teste-lancador.sh            (ERGON_SH=<outro ergon.sh> testa outra cópia)
set -u
# o idioma de partida das mensagens: português (as seções que testam o inglês trocam)
unset LC_ALL LC_MESSAGES ERGON_LANG ERGON_CONFIRM ERGON_CONFIRMAR; export LANG=pt_BR.UTF-8
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ERGON_SH="${ERGON_SH:-$AQUI/../ergon.sh}"
DIAG="${DIAG:-$AQUI/distribuicao/diagnostico-motor.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
OKS=0; FALHAS=0
check() { if eval "$2"; then OKS=$((OKS + 1)); echo "  ok    $1"; else FALHAS=$((FALHAS + 1)); echo "  FALHA $1"; fi; }

hexid() { printf 'a%063d' "$1"; }   # IDs de 64 caracteres hexadecimais (com letra: o awk não os lê como números)
CORE_NOVO=$(hexid 1); CORE_VELHO=$(hexid 2); MOTOR_NOVO=$(hexid 3); MOTOR_USADO=$(hexid 4); MOTOR_PREV=$(hexid 5)
MOTOR_VELHO=$(hexid 6); DOIS_NOMES=$(hexid 7); COM_NOME_DE_FORA=$(hexid 8); TERCEIRO=$(hexid 9)
C=ghcr.io/dono/ergon-community; M=ghcr.io/dono/ergon-community-hermes

mkdir -p "$T/inst" "$T/bin" "$T/estado" "$T/home" "$T/backups"
cp "$ERGON_SH" "$T/inst/ergon.sh"
printf 'ERGON_MOTOR=podman\nERGON_SECRETS_DIR=%s/segredos\n' "$T" > "$T/inst/.env"
echo 1.1.0-rc.22 > "$T/inst/VERSAO"
cat > "$T/inst/docker-compose.yml" <<EOF
services:
  ergon:
    image: $C@sha256:dcorenovo
  hermes:
    image: $M@sha256:dmotornovo
  motores:
    image: $C@sha256:dcorenovo   # o gerente usa a mesma imagem do Ergon
    environment:
      ERGON_MOTOR_IMAGE: $M@sha256:dmotornovo
EOF

# Podman de mentira: imagens (ID repositório etiqueta digest tamanho), contêineres (ID imagem imagem-anterior) e as
# referências do compose (referência ID). Toda chamada fica registrada.
cat > "$T/bin/podman" <<'EOF'
#!/usr/bin/env bash
E="$ESTADO"; echo "$*" >> "$E/chamadas"
em_uso() { awk -v i="$1" '$2 == i { a = 1 } END { exit !a }' "$E/conteineres"; }
nomes() { awk -v i="$1" '$1 == i && $3 != "<none>"' "$E/imagens" | wc -l; }
tira() { awk -v i="$1" -v r="${2:-}" -v t="${3:-}" -v d="${4:-}" '!($1 == i && (r == "" || ($2 == r && (t == "" || $3 == t) && (d == "" || $4 == d))))' "$E/imagens" > "$E/i.tmp"; mv "$E/i.tmp" "$E/imagens"; }
case "$1" in
  info) exit 0 ;;
  ps) awk '{ print $1 }' "$E/conteineres" ;;
  inspect) shift 3; for c in "$@"; do awk -v c="$c" '$1 == c { print $2, ($3 == "-" ? "" : "sha256:" $3) }' "$E/conteineres"; done ;;
  image)
    f=''; [[ "$3" == --format ]] && { f="$4"; x="$5"; } || x="$3"
    i="$(awk -v r="$x" '$1 == r { print $2 }' "$E/refs")"; [[ -n "$i" ]] || i="$x"
    awk -v i="$i" '$1 == i { a = 1 } END { exit !a }' "$E/imagens" || exit 1
    case "$f" in *Size*) awk -v i="$i" '$1 == i { print $5; exit }' "$E/imagens" ;; *Id*) echo "$i" ;; *) echo '[{}]' ;; esac ;;
  images) awk '{ print "sha256:" $1, $2, $3, $4 }' "$E/imagens" ;;
  rmi)
    shift; for a in "$@"; do [[ "$a" == -f || "$a" == --force ]] && { echo FORCOU >> "$E/chamadas"; exit 1; }; done
    x="$1"
    if [[ "$x" =~ ^[0-9a-f]{64}$ ]]; then
      em_uso "$x" && exit 2                       # em uso por um contêiner: sem forçar, não sai
      (( $(nomes "$x") > 1 )) && exit 2           # mais de um nome: pelo ID, só forçando
      tira "$x"
    elif [[ "$x" == *@* ]]; then
      i="$(awk -v r="${x%@*}" -v d="${x#*@}" '$2 == r && $4 == d { print $1; exit }' "$E/imagens")"; [[ -n "$i" ]] || exit 1
      tira "$i" "${x%@*}" '' "${x#*@}"
    else
      i="$(awk -v r="${x%:*}" -v t="${x##*:}" '$2 == r && $3 == t { print $1; exit }' "$E/imagens")"; [[ -n "$i" ]] || exit 1
      tira "$i" "${x%:*}" "${x##*:}"
    fi ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/bin/podman"
export ESTADO="$T/estado" PATH="$T/bin:$PATH" ERGON_MOTOR=podman HOME="$T/home" ERGON_BACKUPS_DIR="$T/backups"

estado_de_partida() {
  : > "$T/estado/chamadas"
  cat > "$T/estado/refs" <<EOF
$C@sha256:dcorenovo $CORE_NOVO
$M@sha256:dmotornovo $MOTOR_NOVO
EOF
  # a do motor da versão nova está no disco sem contêiner (o motor da pessoa ainda na imagem de antes): fica
  cat > "$T/estado/imagens" <<EOF
$CORE_NOVO $C <none> sha256:dcorenovo 400000000
$CORE_VELHO $C <none> sha256:dcorevelho 390000000
$MOTOR_NOVO $M <none> sha256:dmotornovo 3000000000
$MOTOR_USADO $M <none> sha256:dmotorusado 3000000000
$MOTOR_PREV $M <none> sha256:dmotorprev 3000000000
$MOTOR_VELHO $M 1.1.0-rc.20 sha256:dmotorvelho 2900000000
$DOIS_NOMES $C 1.1.0-rc.19 sha256:ddois 380000000
$DOIS_NOMES $C 1.1.0-rc.19-b sha256:ddois 380000000
$COM_NOME_DE_FORA $M 1.1.0-rc.18 sha256:dfora 2800000000
$COM_NOME_DE_FORA outro/projeto latest sha256:dfora 2800000000
$TERCEIRO docker.io/library/postgres 16 sha256:dpg 400000000
EOF
  # o Ergon e o gerente na imagem nova; um motor ainda na de antes; outro já trocado, com a anterior por confirmar
  cat > "$T/estado/conteineres" <<EOF
c1 $CORE_NOVO -
c2 $CORE_NOVO -
c3 $MOTOR_USADO -
c4 $MOTOR_NOVO $MOTOR_PREV
EOF
}
tem() { awk -v i="$1" '$1 == i { a = 1 } END { exit !a }' "$T/estado/imagens"; }
chamou() { grep -q -- "$1" "$T/estado/chamadas"; }

# carrega só as funções do lançador (os testes rodam em subshells: o "fail" dele encerra só o caso)
carregar() { set +u; source "$T/inst/ergon.sh"; local r=$?; set +e +u; return $r; }

echo 'A) limpar depois de atualizar: só as antigas do Ergon, sem forçar'
estado_de_partida
saida="$( (carregar && limpar) 2>&1)"; echo "$saida" | sed 's/^/      /'
check 'tira a imagem antiga do serviço' '! tem $CORE_VELHO'
check 'tira a imagem antiga do motor de IA (repositório -hermes)' '! tem $MOTOR_VELHO'
check 'imagem antiga com dois nomes do Ergon sai (os nomes um a um, sem forçar)' '! tem $DOIS_NOMES'
check 'a atual do serviço fica' 'tem $CORE_NOVO'
check 'a atual do motor fica mesmo sem contêiner (o "prune" a apagaria)' 'tem $MOTOR_NOVO'
check 'a de um motor ainda ligado na versão de antes fica' 'tem $MOTOR_USADO'
check 'a anterior de um motor ainda não confirmado fica (para voltar)' 'tem $MOTOR_PREV'
check 'imagem com um nome de outro projeto fica, só com esse nome' 'tem $COM_NOME_DE_FORA && grep -q "outro/projeto" "$T/estado/imagens" && ! grep -q "$M 1.1.0-rc.18" "$T/estado/imagens"'
check 'imagem de outro projeto não é tocada' 'tem $TERCEIRO && ! chamou "rmi $TERCEIRO" && ! chamou "postgres"'
check 'nunca força (rmi sem -f)' '! chamou FORCOU'
check 'nunca mexe em volume nem usa prune' '! chamou "volume" && ! chamou "prune"'
check 'diz quanto liberou' 'echo "$saida" | grep -q "Limpeza: 3 imagem(ns) antiga(s) do Ergon removida(s)"'

echo 'B) limpar tudo (no remover, contêineres já fora): todas as do Ergon, as do motor também'
estado_de_partida; : > "$T/estado/conteineres"
(carregar && limpar tudo) > /dev/null 2>&1
check 'nenhuma imagem do serviço fica' '! grep -q " $C " "$T/estado/imagens"'
check 'nenhuma imagem do motor de IA fica com nome do Ergon' '! grep -q " $M " "$T/estado/imagens"'
check 'a de outro projeto fica' 'tem $TERCEIRO && grep -q "outro/projeto" "$T/estado/imagens"'
check 'sem forçar e sem volume' '! chamou FORCOU && ! chamou volume'

echo 'C) repositório de uma referência'
r="$( (carregar && repo_de localhost:5000/x/ergon-community:1.1.0-rc.24 && repo_de "$M@sha256:abc" && repo_de ergon:dev && repo_de ergon) 2>/dev/null | tr '\n' ' ')"
check 'etiqueta, digest e porta do registro' '[[ "$r" == "localhost:5000/x/ergon-community $M ergon ergon " ]]'

echo 'D) backups: ficam os 7 mais recentes; o recém-feito sempre; o resto da pasta não é tocado'
for d in 1 2 3 4 5 6 7 8 9; do mkdir -p "$T/backups/ergon-2026-11-0${d}T10-00-00-000Z"; done
: > "$T/backups/ergon-2026-10-01T10-00-00-000Z.sqlite"; : > "$T/backups/ergon-2026-10-01T10-00-00-000Z.sqlite.keyring.json"
: > "$T/backups/minhas-notas.txt"; mkdir -p "$T/backups/ergon-2026-01-01T00-00-00-000Z"   # relógio atrasado
(carregar && girar_backups ergon-2026-01-01T00-00-00-000Z) > /dev/null 2>&1
ficou="$(ls -1 "$T/backups" | tr '\n' ' ')"
check 'o recém-feito fica (mesmo com a data atrasada)' '[[ -d "$T/backups/ergon-2026-01-01T00-00-00-000Z" ]]'
check 'mais os 6 mais novos' '[[ "$(ls -1d "$T"/backups/ergon-2026-11-0* | wc -l)" -eq 6 && -d "$T/backups/ergon-2026-11-04T10-00-00-000Z" && ! -d "$T/backups/ergon-2026-11-03T10-00-00-000Z" ]]'
check 'o backup antigo (.sqlite) sai com o keyring dele' '[[ ! -e "$T/backups/ergon-2026-10-01T10-00-00-000Z.sqlite" && ! -e "$T/backups/ergon-2026-10-01T10-00-00-000Z.sqlite.keyring.json" ]]'
check 'arquivo que não é backup do Ergon fica' '[[ -e "$T/backups/minhas-notas.txt" ]]'
mkdir -p "$T/backups/ergon-2026-11-01T10-00-00-000Z"
(carregar && ERGON_BACKUPS_MANTER=0 girar_backups) > /dev/null 2>&1
check 'ERGON_BACKUPS_MANTER=0 guarda todos' '[[ -d "$T/backups/ergon-2026-11-01T10-00-00-000Z" ]]'

echo 'E) versões guardadas: fica só a anterior'
mkdir -p "$T/home/.ergon/versoes/1.1.0-rc.20" "$T/home/.ergon/versoes/1.1.0-rc.21" "$T/home/.ergon/versoes/1.1.0-rc.22"
(carregar && limpar_versoes "$HOME/.ergon/versoes/1.1.0-rc.22") > /dev/null 2>&1
check 'só a 1.1.0-rc.22 continua' '[[ "$(ls -1 "$T/home/.ergon/versoes" | tr "\n" " ")" == "1.1.0-rc.22 " ]]'

echo 'F) atualizar (pacote): limpa só com a versão nova no ar'
mkdir -p "$T/novo"; echo 1.1.0-rc.24 > "$T/novo/VERSAO"; cp "$T/inst/docker-compose.yml" "$T/novo/docker-compose.yml"
printf 'pacote de mentira' > "$T/bundle.zip"; SHA="$(sha256sum "$T/bundle.zip" | cut -d' ' -f1)"
atualizar_com() {   # $1: o "up" da versão nova responde? (0 sim, 1 não)
  estado_de_partida; rm -rf "$T/home/.ergon/versoes"; mkdir -p "$T/home/.ergon/versoes/0.9.0"; echo 1.1.0-rc.22 > "$T/inst/VERSAO"
  ( carregar
    backup() { return 0; }
    up() { return "$UP"; }
    curl() { if [[ " $* " == *" -o "* ]]; then cp "$T/bundle.zip" "${@: -1}"; else printf '{"version":"1.1.0-rc.24","bundle":"http://127.0.0.1:1/x.zip","sha256":"%s"}' "$SHA"; fi; }
    unzip() { mkdir -p x && cp -r "$T/novo/." x/; }
    UP="$1" atualizar ) > "$T/atualizar.log" 2>&1
}
atualizar_com 0
check 'versão nova aplicada' '[[ "$(cat "$T/inst/VERSAO")" == 1.1.0-rc.24 ]]'
check 'no ar: limpou as imagens antigas' '! tem $CORE_VELHO && tem $MOTOR_NOVO'
check 'no ar: das versões guardadas, só a anterior (1.1.0-rc.22)' '[[ "$(ls -1 "$T/home/.ergon/versoes" | tr "\n" " ")" == "1.1.0-rc.22 " ]]'
atualizar_com 1
check 'não respondeu: nada de limpeza (a de antes pode precisar das imagens dela)' 'tem $CORE_VELHO && ! chamou "images"'

echo 'G) como comando: ergon.sh clean (e o limpar de antes)'
estado_de_partida
saida="$(bash "$T/inst/ergon.sh" clean 2>&1)"; r=$?
check 'roda e diz o que tirou' '[[ $r == 0 ]] && echo "$saida" | grep -q "Limpeza: 3"'
estado_de_partida
saida="$(bash "$T/inst/ergon.sh" limpar 2>&1)"; r=$?
check 'o nome de antes (limpar) faz o mesmo' '[[ $r == 0 ]] && echo "$saida" | grep -q "Limpeza: 3"'
estado_de_partida
saida="$(LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" clean 2>&1)"
check 'em inglês com o sistema em inglês' 'echo "$saida" | grep -q "Cleanup: 3 old Ergon image(s) removed"'
check 'a ajuda mostra o clean (antes: limpar)' 'bash "$T/inst/ergon.sh" | grep -q "clean  (antes: limpar)"'

echo 'H) diagnóstico do motor: imagem em uso ao lado da configurada, capacidades do plugin, sem segredos'
mkdir -p "$T/bin-diag"
cat > "$T/bin-diag/podman" <<'EOF'
#!/usr/bin/env bash
E="$ESTADO"; echo "$*" >> "$E/diag-chamadas"
novo=$(printf 'b%063d' 1); velho=$(printf 'b%063d' 2)
uso="$(cat "$E/diag-uso")"
case "$1" in
  info) exit 0 ;;
  ps) case "$*" in *compose.service=motores*) echo g1 ;; *ergon.motor*) echo m1 ;; esac ;;
  image) case "$*" in *plugin.version*) [[ "$*" == *"$novo"* ]] && echo 0.3.0 || echo '<no value>' ;; *) echo "sha256:$novo" ;; esac ;;
  inspect)
    f="$3"; c="$4"
    case "$f" in
      *'.Name}} {{.State.Status'*) echo '/ergon_motores_1 running' ;;
      *State.Running*) echo true ;;
      *Config.Env*) if [[ "$c" == g1 ]]; then printf 'ERGON_MOTOR_IMAGE=ghcr.io/dono/ergon-community-hermes@sha256:dnovo\nERGON_BRIDGE_TOKEN=segredo-do-gerente-123\n'
                    else printf 'ERGON_BRIDGE_TOKEN=segredo-do-motor-456\nAPI_SERVER_KEY=chave-secreta-789\n'; fi ;;
      '{{.Name}}') echo /ergon-motor-abc ;;
      '{{.State.Status}}') echo running ;;
      *ImageName*) [[ "$uso" == novo ]] && echo ghcr.io/dono/ergon-community-hermes@sha256:dnovo || echo ghcr.io/dono/ergon-community-hermes@sha256:dvelho ;;
      '{{.Image}}') [[ "$uso" == novo ]] && echo "$novo" || echo "$velho" ;;
      *ergon.motor.volume*) echo ergon_motor-abc ;;
      *) echo '<no value>' ;;
    esac ;;
  exec) case "$*" in *node*) echo '{"ok":true}' ;; *python*) echo '  plugin (cópia no cofre): conexoes_executar aparece 0 vez(es)' ;; esac ;;
esac
EOF
chmod +x "$T/bin-diag/podman"
echo velho > "$T/estado/diag-uso"; : > "$T/estado/diag-chamadas"
saida="$(PATH="$T/bin-diag:$PATH" bash "$DIAG" estado podman 2>&1)"; echo "$saida" | sed 's/^/      /'
check 'mostra a imagem em uso e a configurada' 'echo "$saida" | grep -q "na imagem ghcr.io/dono/ergon-community-hermes@sha256:dvelho" && echo "$saida" | grep -q "configurada ghcr.io/dono/ergon-community-hermes@sha256:dnovo"'
check 'motor em outra imagem: DESATUALIZADO' 'echo "$saida" | grep -q DESATUALIZADO'
check 'a versão do plugin de cada imagem (a antiga não tem a marca)' 'echo "$saida" | grep -q "plugin 0.3.0" && echo "$saida" | grep -q "plugin sem marca"'
check 'o gerente responde pelo /health direto' 'echo "$saida" | grep -q "/health: {\"ok\":true}"'
check 'lê o cofre como o usuário do motor (--user 10000)' 'grep -q "exec --user 10000 m1" "$T/estado/diag-chamadas"'
check 'das variáveis, só os nomes' 'echo "$saida" | grep -q "ERGON_BRIDGE_TOKEN" && ! echo "$saida" | grep -q -e segredo- -e chave-secreta'
echo novo > "$T/estado/diag-uso"
saida="$(PATH="$T/bin-diag:$PATH" bash "$DIAG" estado podman 2>&1)"
check 'na imagem configurada: em dia' 'echo "$saida" | grep -q "em dia com a imagem configurada" && ! echo "$saida" | grep -q DESATUALIZADO'

echo 'I) comandos: os nomes novos e os de antes fazem a mesma coisa'
# cada passo do lançador vira um registro (nada é instalado, ligado ou apagado)
reg() { printf '%s\n' "$*" >> "$T/passos"; }
simular() {
  instalar_programa() { DESTINO="$RAIZ"; reg instalar_programa; }
  need_motor() { reg need_motor; }; init_secrets() { reg init_secrets; }; registrar() { reg registrar; }
  up() { reg up; }; instalar_ajudante() { reg instalar_ajudante; }; remover_ajudante() { reg remover_ajudante; }
  ajudante() { reg ajudante; }; abrir() { reg abrir; }; ligar_servicos() { reg ligar_servicos; }
  wait_health() { echo '{}'; }; health() { printf '{"version":"9.9.9","sealed":false}'; }; compose() { reg "compose $*"; }
  backup() { reg backup; }; restaurar() { reg "restaurar ${1:-}"; }; desfazer_restauracao() { reg "desfazer ${1:-}"; }
  atualizar() { reg atualizar; }; limpar() { reg limpar; }; remover() { reg "remover ${1:-}"; }
}
passos() { : > "$T/passos"; ( carregar && simular && comando "$@" ) > "$T/passos.saida" 2>&1; tr '\n' ';' < "$T/passos"; }
mesmo() {   # mesmo "<esperado>" <comando novo...> -- <comando de antes...>
  local esp="$1"; shift; local novo=() antigo=()
  while [[ $# -gt 0 && "$1" != -- ]]; do novo+=("$1"); shift; done; shift; antigo=("$@")
  local a b; a="$(passos "${novo[@]}")"; b="$(passos "${antigo[@]}")"
  check "${novo[*]} = ${antigo[*]}" '[[ "$a" == "$esp" && "$b" == "$esp" ]] || { echo "      novo: $a | antes: $b | esperado: $esp"; false; }'
}
mesmo 'instalar_programa;need_motor;init_secrets;registrar;up;instalar_ajudante;abrir;' install -- instalar
mesmo 'remover ;' uninstall -- remover
mesmo 'remover ;' remove -- remover
mesmo 'remover --purge;' uninstall --purge -- remover --purge
mesmo 'remover --tudo;' uninstall --tudo -- remover --tudo
mesmo 'need_motor;registrar;ligar_servicos;instalar_ajudante;' start -- iniciar
mesmo 'need_motor;registrar;ligar_servicos;' up -- subir
mesmo 'compose stop;' stop -- parar
mesmo 'abrir;' open -- abrir
mesmo 'restaurar /backups/ergon-x;' restore /backups/ergon-x -- restaurar /backups/ergon-x
mesmo 'desfazer pre-restore-1;' restore --undo pre-restore-1 -- desfazer-restauracao pre-restore-1
mesmo 'desfazer pre-restore-1;' undo-restore pre-restore-1 -- desfazer-restauracao pre-restore-1
mesmo 'need_motor;atualizar;' update -- atualizar
mesmo 'need_motor;atualizar;' upgrade -- atualizar
mesmo 'limpar;' clean -- limpar
mesmo 'ajudante;' helper -- ajudante
mesmo 'instalar_ajudante;' helper install -- ajudante instalar
mesmo 'remover_ajudante;' helper uninstall -- ajudante remover
mesmo 'remover_ajudante;' helper remove -- ajudante remover
mesmo 'backup;' backup -- backup
mesmo 'compose ps;' status -- status
mesmo 'compose logs --tail 80 ergon motores;' logs -- logs
a="$(ERGON_NO_BROWSER=1 passos install)"; b="$(ERGON_SEM_NAVEGADOR=1 passos instalar)"
check 'sem navegador: ERGON_NO_BROWSER e o ERGON_SEM_NAVEGADOR de antes' '[[ "$a" != *abrir* && "$b" != *abrir* && "$a" == *instalar_ajudante* ]]'
passos status > /dev/null
check 'status: versão e estado' 'grep -q "Ergon 9.9.9 · aberto" "$T/passos.saida"'
passos xyz > /dev/null; r="$( ( carregar && simular && comando xyz ) > /dev/null 2>&1; echo $?)"
check 'comando desconhecido: sai com erro e mostra a ajuda' '[[ "$r" == 1 ]] && grep -q "Comando desconhecido: xyz" "$T/passos.saida" && grep -q "uninstall --purge" "$T/passos.saida"'

echo 'J) confirmações: s/sim/y/yes; APAGAR ou DELETE; ERGON_CONFIRM e o ERGON_CONFIRMAR de antes'
conf() { ( carregar && confirmar 'Seguir?' <<<"$1" ) > /dev/null 2>&1; }
check 'aceita s, sim, y, yes (maiúsculas também)' 'conf s && conf sim && conf y && conf yes && conf YES && conf Sim'
check 'recusa n, no, vazio e outra coisa' '! conf n && ! conf no && ! conf "" && ! conf talvez'
check 'ERGON_CONFIRM=yes e ERGON_CONFIRMAR=sim respondem sem perguntar' 'ERGON_CONFIRM=yes conf n && ERGON_CONFIRMAR=sim conf n && ERGON_CONFIRM=y conf ""'
# o read só mostra a pergunta num terminal: aqui ele é trocado por um que a imprime
pergunta_pt="$( (carregar && read() { printf '%s' "$3"; } && confirmar 'Seguir?') 2>&1)"
pergunta_en="$( (export LANG=en_US.UTF-8; carregar && read() { printf '%s' "$3"; } && confirmar 'Go?') 2>&1)"
check 'a pergunta mostra (s/N) em português e (y/N) em inglês' '[[ "$pergunta_pt" == *"(s/N)"* && "$pergunta_en" == *"(y/N)"* ]]'
# remover de verdade numa casa de mentira: o motor não responde (nada de contêiner), o ajudante é simulado
purgar() {   # purgar <variável=valor> <opção>: devolve a saída; a casa é recriada a cada vez
  local H="$T/casa"; rm -rf "$H"; mkdir -p "$H/.ergon/secrets" "$H/.ergon/backups/ergon-1"; : > "$H/.ergon/secrets/ergon.env"
  ( export HOME="$H" ERGON_BACKUPS_DIR="$H/.ergon/backups" ERGON_LOCAL_DIR="$H/.ergon" ERGON_INSTALACAO="$H/.ergon/instalacao.json" "$1"
    carregar && MOTOR=false && remover_ajudante() { :; } && remover "$2" ) 2>&1
}
saida="$(purgar ERGON_CONFIRM=talvez --purge)"
check 'uninstall --purge com outra resposta: nada é apagado' 'echo "$saida" | grep -q "Nada foi apagado." && [[ -f "$T/casa/.ergon/secrets/ergon.env" ]]'
saida="$(purgar ERGON_CONFIRM=DELETE --purge)"
check 'uninstall --purge com DELETE: apaga os segredos e os backups' 'echo "$saida" | grep -q "com os dados" && [[ ! -e "$T/casa/.ergon" ]]'
saida="$(purgar ERGON_CONFIRMAR=APAGAR --tudo)"
check 'remover --tudo com APAGAR (o de antes) também' 'echo "$saida" | grep -q "com os dados" && [[ ! -e "$T/casa/.ergon" ]]'
saida="$(purgar ERGON_CONFIRM=APAGAR --all)"
check 'uninstall --all é o mesmo que --purge' '[[ ! -e "$T/casa/.ergon" ]]'
saida="$(purgar ERGON_CONFIRM=DELETE '')"
check 'uninstall sem opção guarda os dados' 'echo "$saida" | grep -q "Segredos e backups guardados" && [[ -f "$T/casa/.ergon/secrets/ergon.env" && -d "$T/casa/.ergon/backups/ergon-1" ]]'
saida="$( (export LANG=en_US.UTF-8; purgar ERGON_CONFIRM=nao --purge) )"
check 'em inglês: pede DELETE e diz que nada foi apagado' 'echo "$saida" | grep -q "This DELETES everything" && echo "$saida" | grep -q "Nothing was deleted."'

echo 'K) idioma das mensagens: o do sistema; ERGON_LANG força'
ajuda_en() { grep -q "Messages follow the system language" <<<"$1"; }
ajuda_pt() { grep -q "(antes: instalar)" <<<"$1"; }
saida="$(LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" help)"
check 'help em inglês: só os nomes novos' 'ajuda_en "$saida" && grep -q "uninstall --purge" <<<"$saida" && grep -q "restore --undo" <<<"$saida" && ! grep -qiE "instalar|remover|atualizar|restaurar|ajudante|antes:" <<<"$saida"'
saida="$(LANG=pt_BR.UTF-8 bash "$T/inst/ergon.sh" help)"
check 'help em português: os nomes novos com o de antes' 'ajuda_pt "$saida" && grep -qF "uninstall --purge  (antes: remover --tudo)" <<<"$saida" && grep -qF "restore --undo <pre-restore-…>  (antes: desfazer-restauracao)" <<<"$saida" && grep -qF "update  (antes: atualizar)" <<<"$saida"'
check '--help, -h, ajuda e sem comando: a mesma ajuda' 'ajuda_pt "$(bash "$T/inst/ergon.sh" --help)" && ajuda_pt "$(bash "$T/inst/ergon.sh" -h)" && ajuda_pt "$(bash "$T/inst/ergon.sh" ajuda)" && ajuda_pt "$(bash "$T/inst/ergon.sh")"'
check 'ERGON_LANG=en vence o sistema em português' 'ajuda_en "$(ERGON_LANG=en LANG=pt_BR.UTF-8 bash "$T/inst/ergon.sh" help)"'
check 'ERGON_LANG=pt vence o sistema em inglês' 'ajuda_pt "$(ERGON_LANG=pt LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" help)"'
check 'LC_ALL vence o LANG; LC_MESSAGES também' 'ajuda_en "$(LC_ALL=en_GB.UTF-8 LANG=pt_BR.UTF-8 bash "$T/inst/ergon.sh" help)" && ajuda_pt "$(LC_MESSAGES=pt_PT.UTF-8 LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" help)"'
check 'outro idioma (espanhol): inglês' 'ajuda_en "$(LANG=es_ES.UTF-8 bash "$T/inst/ergon.sh" help)"'
# a marca do ambiente do Desktop no Windows (/etc/ergon-ambiente) num caminho do teste: sem ela e com ela
export ERGON_AMBIENTE_MARCA="$T/ergon-ambiente"; rm -f "$ERGON_AMBIENTE_MARCA"
check 'sem indicação (C, C.UTF-8, POSIX ou vazio): inglês (VM de nuvem, contêiner, SSH)' 'ajuda_en "$(LANG=C bash "$T/inst/ergon.sh" help)" && ajuda_en "$(LANG=C.UTF-8 bash "$T/inst/ergon.sh" help)" && ajuda_en "$(LANG=POSIX bash "$T/inst/ergon.sh" help)" && ajuda_en "$(env -u LANG bash "$T/inst/ergon.sh" help)"'
echo 1.1.0-rc.26 > "$ERGON_AMBIENTE_MARCA"
check 'sem indicação no ambiente do Desktop no Windows (com a marca): português' 'ajuda_pt "$(LANG=C bash "$T/inst/ergon.sh" help)" && ajuda_pt "$(env -u LANG bash "$T/inst/ergon.sh" help)"'
check 'no ambiente, um idioma dito vence a marca' 'ajuda_en "$(LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" help)" && ajuda_en "$(ERGON_LANG=en env -u LANG bash "$T/inst/ergon.sh" help)"'
rm -f "$ERGON_AMBIENTE_MARCA"
check 'o Desktop passa ERGON_LANG=pt: português mesmo com o sistema em inglês' 'ajuda_pt "$(ERGON_LANG=pt LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 bash "$T/inst/ergon.sh" help)"'
saida="$(LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" restore 2>&1)"; r=$?
check 'erro em inglês com o sistema em inglês' '[[ $r == 1 ]] && grep -qF "[ergon] Say which backup: ./ergon.sh restore <backup folder>" <<<"$saida"'
saida="$(LANG=pt_BR.UTF-8 bash "$T/inst/ergon.sh" restaurar 2>&1)"; r=$?
check 'erro em português com o sistema em português' '[[ $r == 1 ]] && grep -qF "[ergon] Diga qual backup: ./ergon.sh restore <pasta do backup>" <<<"$saida"'
saida="$(LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" restore --undo errado 2>&1)"
check 'restore --undo sem um nome válido: explica em inglês' 'grep -qF "Say which one: ./ergon.sh restore --undo pre-restore-<date>" <<<"$saida"'
saida="$(LANG=en_US.UTF-8 bash "$T/inst/ergon.sh" xyz 2>&1)"; r=$?
check 'comando desconhecido em inglês' '[[ $r == 1 ]] && grep -q "Unknown command: xyz" <<<"$saida"'
# toda mensagem tem as duas versões: nenhuma chamada de say/fail/log_ajudante com um texto só (as aspas escapadas
# saem antes, para a expressão achar o fim de cada texto)
UMA='\b(say|fail|log_ajudante) ('"'"'[^'"'"']*'"'"'|"[^"]*")[[:space:]]*($|;|\}|\|\||&&)'
uma_lingua="$(sed 's/\\"//g' "$T/inst/ergon.sh" | grep -nE "$UMA" || true)"
check 'nenhuma mensagem só em um idioma' '[[ -z "$uma_lingua" ]] || { echo "$uma_lingua" | sed "s/^/      /"; false; }'
cat > "$T/amostra.sh" <<'EOF'
  x || say 'só um'; y
  fail "um \"dois\" três" || true
  say 'pt' 'en'
EOF
check 'a conferência acha uma mensagem só em um idioma' '[[ "$(sed "s/\\\\\"//g" "$T/amostra.sh" | grep -cE "$UMA")" == 2 ]]'

echo 'L) version'
echo 1.1.0-rc.26 > "$T/inst/VERSAO"
check 'version e --version leem o VERSAO' '[[ "$(bash "$T/inst/ergon.sh" version)" == "Ergon 1.1.0-rc.26" && "$(bash "$T/inst/ergon.sh" --version)" == "Ergon 1.1.0-rc.26" ]]'
mkdir -p "$T/fonte/server"; cp "$T/inst/ergon.sh" "$T/fonte/"; : > "$T/fonte/Dockerfile"; printf '{\n  "name": "x",\n  "version": "1.1.0-rc.27"\n}\n' > "$T/fonte/package.json"
check 'cópia do código: a versão do package.json' '[[ "$(bash "$T/fonte/ergon.sh" version)" == "Ergon 1.1.0-rc.27" ]]'
rm -f "$T/fonte/package.json"; saida="$(LANG=en_US.UTF-8 bash "$T/fonte/ergon.sh" version 2>&1)"; r=$?
check 'sem VERSAO: diz que não sabe (e sai com erro)' '[[ $r == 1 ]] && grep -q "Unknown version" <<<"$saida"'

echo 'M) install de um pacote de verdade: copia para a pasta do programa e segue pela cópia instalada'
# o pacote (sem Dockerfile: não é cópia do código) com o lançador deste teste; antes do "comando", um arquivo
# troca os passos que ligariam algo de verdade por registros. A cópia para a pasta do programa e a chamada da
# cópia instalada são as do lançador.
mkdir -p "$T/pacote"
sed '$d' "$ERGON_SH" > "$T/pacote/ergon.sh"
printf '[[ -n "${STUB:-}" ]] && source "$STUB"\ncomando "$@"\n' >> "$T/pacote/ergon.sh"
cp "$T/inst/docker-compose.yml" "$T/pacote/"; echo 1.1.0-rc.26 > "$T/pacote/VERSAO"; : > "$T/pacote/LEIA-ME.md"
cat > "$T/stub.sh" <<'EOF'
r() { printf '%s %s\n' "$(basename "$RAIZ")" "$*" >> "$PASSOS"; }
r "lancador $*"
need_motor() { r need_motor; }; init_secrets() { r init_secrets; }; registrar() { r registrar; }; up() { r up; }
instalar_ajudante() { r instalar_ajudante; }; abrir() { r abrir; }
EOF
instalar_pacote() {   # instalar_pacote <comando>: a saída; os passos ficam em $T/passos-pacote
  rm -rf "$T/programa" "$T/bin-programa"; : > "$T/passos-pacote"
  ( cd "$T/pacote" && STUB="$T/stub.sh" PASSOS="$T/passos-pacote" ERGON_PROGRAM_DIR="$T/programa" ERGON_BIN_DIR="$T/bin-programa" \
      ERGON_NO_BROWSER=1 bash "$T/pacote/ergon.sh" "$1" ) 2>&1
}
for nome in install instalar; do
  saida="$(instalar_pacote "$nome")"; r=$?
  passos_pacote="$(tr '\n' ';' < "$T/passos-pacote")"
  check "$nome: o pacote vai para a pasta do programa" '[[ $r == 0 && -f "$T/programa/ergon.sh" && -f "$T/programa/docker-compose.yml" && -f "$T/programa/VERSAO" && -f "$T/programa/LEIA-ME.md" ]] || { echo "$saida" | tail -5 | sed "s/^/      /"; false; }'
  check "$nome: a cópia instalada recebe install e chega aos segredos e ao registro" '[[ "$passos_pacote" == "pacote lancador $nome;programa lancador install;programa need_motor;programa init_secrets;programa registrar;programa up;programa instalar_ajudante;" ]] || { echo "      $passos_pacote"; false; }'
  check "$nome: o comando ergon aponta para a pasta do programa" 'grep -qF "$T/programa/ergon.sh" "$T/bin-programa/ergon"'
  check "$nome: diz que a pasta do zip pode ser apagada" 'grep -q "Pode apagar a pasta do zip" <<<"$saida"'
done

echo ''
echo "$OKS ok, $FALHAS falha(s)"
(( FALHAS == 0 ))
