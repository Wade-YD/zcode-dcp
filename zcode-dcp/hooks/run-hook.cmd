@echo off
rem ZCode DCP v0.2.0 hook wrapper (ASCII only - cmd.exe parses this file in the OEM codepage)
rem Forwards stdin (hook input JSON) and the mode argument to auto-watch.cjs via node.
setlocal
set "NODE_EXE=node"
where node >nul 2>nul
if %errorlevel%==0 goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe" & goto run
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe" & goto run
exit /b 1

:run
"%NODE_EXE%" "%~dp0auto-watch.cjs" %*
exit /b %errorlevel%
