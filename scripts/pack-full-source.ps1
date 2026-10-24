param(
  [string]$ProductName = "Veo Workflow Tools"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root "full-source-app"
$Out = Join-Path $Root "full-release"
$Resources = Join-Path $Root "full-resources"
$Packager = Join-Path $Root "desktop-app\node_modules\.bin\electron-packager.cmd"
$Icon = Join-Path $Root "desktop-app\assets\icon.ico"

if (-not (Test-Path $Source)) {
  throw "Missing full-source-app at $Source"
}
if (-not (Test-Path $Packager)) {
  throw "Missing electron-packager at $Packager"
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# Build from the editable source and refresh both unpacked backend mirrors before
# electron-packager copies full-resources/server into the release. Without this,
# an older runtime can silently overwrite the freshly built server in the app.
& npm.cmd run build
if ($LASTEXITCODE -ne 0) {
  throw "source build failed with code $LASTEXITCODE"
}

& node (Join-Path $Root "scripts\sync-built-server-runtime.cjs")
if ($LASTEXITCODE -ne 0) {
  throw "server runtime sync failed with code $LASTEXITCODE"
}

& $Packager $Source $ProductName `
  --platform=win32 `
  --arch=x64 `
  --out=$Out `
  --overwrite `
  --asar `
  --prune=false `
  --electron-version=33.2.0 `
  --icon=$Icon

if ($LASTEXITCODE -ne 0) {
  throw "electron-packager failed with code $LASTEXITCODE"
}

$ReleaseResources = Join-Path $Out "$ProductName-win32-x64\resources"
if (-not (Test-Path $ReleaseResources)) {
  throw "Release resources folder not found: $ReleaseResources"
}

foreach ($name in @("server", "app.asar.unpacked", "extension", "fablecut")) {
  $src = Join-Path $Resources $name
  if (Test-Path $src) {
    robocopy $src (Join-Path $ReleaseResources $name) /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) {
      throw "robocopy failed for $name with code $LASTEXITCODE"
    }
  }
}

foreach ($name in @("elevate.exe", "app-update.yml")) {
  $src = Join-Path $Resources $name
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $ReleaseResources $name) -Force
  }
}

Write-Host "full-release=$Out\$ProductName-win32-x64"
