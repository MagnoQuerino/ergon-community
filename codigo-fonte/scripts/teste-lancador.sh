#!/usr/bin/env bash
# Teste da limpeza do lançador (ergon.sh) com um Podman simulado: imagens, contêineres e nomes de mentira; nenhuma
# instalação real é tocada. Confere que a limpeza só tira imagens antigas dos repositórios do Ergon, sem forçar, e
# nunca a atual (nem a atual do motor sem contêiner), a de um contêiner, a anterior de um motor ainda não confirmada,
# a de outro projeto ou um volume; que o remover tira todas as do Ergon (as do motor de IA também); que os backups
# giram (ficam os 7 mais recentes, o recém-feito sempre); que das versões guardadas fica só a anterior; e que o
# atualizar chama a limpeza só quando a versão nova está no ar. Por fim, o diagnóstico do motor
# (scripts/distribuicao/diagnostico-motor.sh estado): imagem em uso ao lado da configurada, sem segredo nenhum.
#   bash scripts/teste-lancador.sh            (ERGON_SH=<outro ergon.sh> testa outra cópia)
set -u
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

echo 'G) como comando: ergon.sh limpar'
estado_de_partida
saida="$(bash "$T/inst/ergon.sh" limpar 2>&1)"; r=$?
check 'roda e diz o que tirou' '[[ $r == 0 ]] && echo "$saida" | grep -q "Limpeza: 3"'
check 'a ajuda mostra o limpar' 'bash "$T/inst/ergon.sh" | grep -q "limpar"'

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

echo ''
echo "$OKS ok, $FALHAS falha(s)"
(( FALHAS == 0 ))
