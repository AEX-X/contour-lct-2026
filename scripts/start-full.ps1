param(
    [string]$MlDataDir
)

. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady
$resolvedMlData = Assert-ContourMlData -Path $MlDataDir
$env:ML_DATA_DIR = $resolvedMlData
$compose = Get-ContourComposeArguments -Mode Full

Write-Host "Запуск Contour в полном режиме с реальными ML-моделями" -ForegroundColor Cyan
Write-Host "ML-данные: $resolvedMlData"

Invoke-ContourDocker -Arguments ($compose + @("config", "--quiet"))
try {
    Invoke-ContourDocker -Arguments ($compose + @("up", "--detach", "--build", "--wait", "--wait-timeout", "1200"))
}
catch {
    & docker @compose ps
    Write-Host "Диагностика: docker compose --project-name contour-full -f docker-compose.yml -f docker-compose.ml.yml logs" -ForegroundColor Yellow
    throw
}

& (Join-Path $PSScriptRoot "smoke-test.ps1") -Mode Full
if ($LASTEXITCODE -ne 0) {
    throw "Стек запущен, но smoke-test не пройден"
}

Write-Host "Contour готов: $(Get-ContourBaseUrl)" -ForegroundColor Green
Write-Host "Режим прогнозов: реальные ML-модели"
