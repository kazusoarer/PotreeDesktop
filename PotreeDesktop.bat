@echo off
rem potree_share_desktop 起動 (= どこから起動しても確実に動くよう作業フォルダを固定)
cd /d "%~dp0"
rem VSCode 等の環境変数が残っていると Electron が GUI で起動しないため除去
set "ELECTRON_RUN_AS_NODE="
start "" ".\node_modules\electron\dist\electron.exe" .
