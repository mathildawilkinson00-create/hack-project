@echo off
rem Double-clic pour lancer Point Right (version application).
rem La premiere fois, installe Electron automatiquement (internet requis).
cd /d "%~dp0"
rem Si cette variable est definie (ex: depuis VS Code), Electron se lance comme du Node simple.
set ELECTRON_RUN_AS_NODE=
if not exist node_modules call npm install
if not exist node_modules\electron\dist call node node_modules\electron\install.js
call npm start
