@echo off
rem ============================================================
rem  初回セットアップ (= 他の PC で GitHub から取得した後に 1 回だけ実行)
rem  必要なもの: Node.js (https://nodejs.org/ の LTS 版)
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo   https://nodejs.org/ から LTS 版をインストールしてから再実行してください。
  pause
  exit /b 1
)

echo Node.js: OK
echo 依存パッケージを取得しています (数分かかります)...
call npm install
if errorlevel 1 (
  echo [エラー] npm install に失敗しました。ネットワークを確認して再実行してください。
  pause
  exit /b 1
)

echo.
echo セットアップ完了。PotreeDesktop.bat で起動できます。
echo (デスクトップにショートカットを作る場合は PotreeDesktop.bat を右クリック→送る→デスクトップ)
pause
