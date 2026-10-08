Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 18 or newer is required.'
    exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    & node install
}

$QODE = & node -p "require('@nodegui/qode').qodePath"
$QT_HOME = & node -p "require('@nodegui/nodegui/config/qtConfig').qtHome"

if (-not $QODE -or -not (Test-Path $QODE)) {
    Write-Error "Qode was not found at '$QODE'. Run npm install in this folder first."
    exit 1
}
if (-not $QT_HOME -or -not (Test-Path $QT_HOME)) {
    Write-Error "Qt was not found at '$QT_HOME'. Run npm install in this folder first."
    exit 1
}

$OUT = Join-Path $root 'build/repuber-win'
if (Test-Path $OUT) { Remove-Item $OUT -Recurse -Force }
$AppDir = Join-Path $OUT 'app'
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

Copy-Item (Join-Path $root 'package.json') $AppDir -Force
Copy-Item (Join-Path $root 'package-lock.json') $AppDir -Force
Copy-Item (Join-Path $root 'app.js') $AppDir -Force
Copy-Item (Join-Path $root 'src') $AppDir -Recurse -Force
Copy-Item (Join-Path $root 'static') $AppDir -Recurse -Force
Copy-Item (Join-Path $root 'cores') $AppDir -Recurse -Force
Copy-Item (Join-Path $root 'node_modules') $AppDir -Recurse -Force
Copy-Item $QODE (Join-Path $OUT 'qode.exe') -Force

$QT_REL = [System.IO.Path]::GetRelativePath((Join-Path $AppDir 'node_modules'), $QT_HOME)
$QT_REL = $QT_REL -replace '[\\/]+', '\'

$launcher = @"
@echo off
setlocal
set "ROOT=%~dp0"
set "QT=%ROOT%app\node_modules\$QT_REL"
set "PATH=%QT%\bin;%PATH%"
set "QT_PLUGIN_PATH=%QT%\plugins"
set "QT_QPA_PLATFORM_PLUGIN_PATH=%QT%\plugins\platforms"
set "QML2_IMPORT_PATH=%QT%\qml"
cd /d "%ROOT%app"
"%ROOT%qode.exe" "%ROOT%app\app.js" %*
"@

Set-Content -Path (Join-Path $OUT 'repuber.cmd') -Value $launcher -Encoding ASCII

Write-Host "Windows launcher written to $OUT\repuber.cmd"
