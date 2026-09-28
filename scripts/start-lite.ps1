. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady
$compose = Get-ContourComposeArguments -Mode Lite

Write-Host "Запуск Contour Lite" -ForegroundColor Cyan
Write-Warning "Используется StubPredictor. Этот режим предназначен для UI и интеграционной разработки, а не для демонстрации качества ML"

Invoke-ContourDocker -Arguments ($compose + @("config", "--quiet"))
try {
    Invoke-ContourDocker -Arguments ($compose + @("up", "--detach", "--build", "--wait", "--wait-timeout", "600"))
}
catch {
    & docker @compose ps
    Write-Host "Диагностика: docker compose --project-name contour-lite -f docker-compose.yml logs" -ForegroundColor Yellow
    throw
}

& (Join-Path $PSScriptRoot "smoke-test.ps1") -Mode Lite
if ($LASTEXITCODE -ne 0) {
    throw "Стек запущен, но smoke-test не пройден"
}

Write-Host "Contour Lite готов: $(Get-ContourBaseUrl)" -ForegroundColor Green
Write-Host "Режим прогнозов: StubPredictor" -ForegroundColor Yellow
