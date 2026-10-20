@echo off
rem Starts SplatStation. Uses Node's install folder directly so it works even if PATH is stale.
set NODE=node
if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"
%NODE% "%~dp0station\station.mjs" %*
pause
