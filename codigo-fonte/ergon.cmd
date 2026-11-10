@echo off
rem Atalho do lancador do Ergon no Windows. Exemplos: ergon install, ergon status, ergon update (ergon help: todos)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ergon.ps1" %*
