# Cloudflare OS をローカル起動する (Windows 用)
# `pnpm run-local` は Windows では pnpm の JS エントリを npm_execpath 経由で探すため、
# 直接実行すると "spawnSync pnpm ENOENT" で失敗する。ここで明示的に設定して起動する。
$pnpmEntry = Join-Path $env:APPDATA "npm\node_modules\pnpm\bin\pnpm.mjs"
if (-not (Test-Path $pnpmEntry)) {
  Write-Error "pnpm が見つかりません。'npm i -g pnpm' を実行してください。 ($pnpmEntry)"
  exit 1
}
$env:npm_execpath = $pnpmEntry
Set-Location $PSScriptRoot
node scripts/run-local.ts @args
