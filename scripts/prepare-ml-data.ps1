param(
    [Parameter(Mandatory)]
    [string]$SourceDir,
    [string]$OutputDir,
    [string]$CacheDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repoRoot "ml-data"
}
if ([string]::IsNullOrWhiteSpace($CacheDir)) {
    $CacheDir = Join-Path $repoRoot ".cache\ml-prepare"
}

if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    throw "Каталог исходного dataset не найден: $SourceDir"
}
$source = (Resolve-Path -LiteralPath $SourceDir).Path
$venv = Join-Path $repoRoot ".cache\ml-prepare-venv"
$venvPython = Join-Path $venv "Scripts\python.exe"

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string]$Command,
        [Parameter(ValueFromRemainingArguments)]
        [string[]]$Arguments
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command завершился с кодом $LASTEXITCODE"
    }
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        Invoke-Checked -Command $launcher.Source -Arguments @("-3.12", "-c", "import sys; assert sys.version_info[:2] == (3, 12)")
        Invoke-Checked -Command $launcher.Source -Arguments @("-3.12", "-m", "venv", $venv)
    }
    else {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) {
            throw "Python 3.12 не найден. Установи Python 3.12 x64"
        }
        Invoke-Checked -Command $python.Source -Arguments @("-c", "import sys; assert sys.version_info[:2] == (3, 12)")
        Invoke-Checked -Command $python.Source -Arguments @("-m", "venv", $venv)
    }
}

Invoke-Checked -Command $venvPython -Arguments @(
    "-m", "pip", "install", "--disable-pip-version-check", "-r",
    (Join-Path $PSScriptRoot "requirements-prepare-ml.txt")
)

Write-Host "Подготовка ML-данных из $source" -ForegroundColor Cyan
Write-Host "Выход: $OutputDir"
Write-Host "Кэш: $CacheDir"
Write-Host "Скрипт можно безопасно перезапустить. Готовые корректные годы будут пропущены"

Invoke-Checked -Command $venvPython -Arguments @(
    (Join-Path $PSScriptRoot "prepare_ml_data.py"),
    "--source", $source,
    "--repo", $repoRoot,
    "--output", $OutputDir,
    "--cache", $CacheDir
)

& (Join-Path $PSScriptRoot "check-ml-data.ps1") -MlDataDir $OutputDir
if (-not $?) {
    throw "Итоговая проверка ML-данных не пройдена"
}

Write-Host "ML-данные готовы. Теперь запусти .\scripts\start-full.ps1" -ForegroundColor Green
