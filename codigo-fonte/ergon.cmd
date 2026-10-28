@echo off
rem Atalho do lancador do Ergon no Windows. Exemplos: ergon instalar, ergon status, ergon atualizar
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ergon.ps1" %*
