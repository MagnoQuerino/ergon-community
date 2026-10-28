@echo off
rem Instala o Ergon neste computador. Precisa do Docker Desktop instalado e aberto.
rem Dois cliques bastam: no fim o navegador abre o Ergon e o comando "ergon" passa a valer em qualquer terminal.
call "%~dp0codigo-fonte\instalador\ergon.cmd" instalar
set ERRO=%ERRORLEVEL%
echo.
if not defined ERGON_SEM_PAUSA pause
exit /b %ERRO%
