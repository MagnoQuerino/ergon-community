@echo off
rem Lancador antigo do Ergon no Windows (Docker Desktop, ate a rc.11): so mostra o aviso do aplicativo Ergon Desktop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ergon.ps1" %*
