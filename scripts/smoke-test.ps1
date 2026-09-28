param(
    [ValidateSet("Full", "Lite")]
    [string]$Mode = "Full",
    [string]$BaseUrl
)

. (Join-Path $PSScriptRoot "common.ps1")

function ConvertTo-ContourDateTimeOffset {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$FieldName
    )

    if ($Value -is [DateTimeOffset]) {
        return $Value
    }
    if ($Value -is [DateTime]) {
        return [DateTimeOffset]$Value
    }

    $parsed = [DateTimeOffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::RoundtripKind
    if ([DateTimeOffset]::TryParse(
        [string]$Value,
        [System.Globalization.CultureInfo]::InvariantCulture,
        $styles,
        [ref]$parsed
    )) {
        return $parsed
    }

    throw "Поле $FieldName содержит некорректную дату: $Value"
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = Get-ContourBaseUrl
}
$BaseUrl = $BaseUrl.TrimEnd("/")

$restParameters = @{
    TimeoutSec = 30
}
$webParameters = @{
    TimeoutSec = 30
}
if ((Get-Command Invoke-RestMethod).Parameters.ContainsKey("SkipCertificateCheck")) {
    $restParameters.SkipCertificateCheck = $true
    $webParameters.SkipCertificateCheck = $true
}
else {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}
if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey("UseBasicParsing")) {
    $webParameters.UseBasicParsing = $true
}

Write-Host "Smoke-test ${Mode}: $BaseUrl" -ForegroundColor Cyan

$health = Invoke-RestMethod @restParameters -Method Get -Uri "$BaseUrl/health"
if ($health.status -ne "ok") {
    throw "Backend healthcheck вернул неожиданный статус: $($health.status)"
}

$frontend = Invoke-WebRequest @webParameters -Method Get -Uri "$BaseUrl/"
if ($frontend.StatusCode -ne 200 -or $frontend.Content -notmatch '<div id="root">') {
    throw "Frontend не отдал ожидаемый index.html"
}
$contentSecurityPolicy = [string]$frontend.Headers["Content-Security-Policy"]
if ($contentSecurityPolicy -notmatch "default-src 'self'" -or $contentSecurityPolicy -notmatch "object-src 'none'") {
    throw "Gateway не отдал ожидаемый Content-Security-Policy"
}

$loginBody = @{ username = "manager"; password = "manager123" } | ConvertTo-Json
$session = Invoke-RestMethod @restParameters -Method Post -Uri "$BaseUrl/api/v1/auth/login" -ContentType "application/json" -Body $loginBody
if ([string]::IsNullOrWhiteSpace($session.token)) {
    throw "Авторизация не вернула token"
}

$headers = @{ Authorization = "Bearer $($session.token)" }
$me = Invoke-RestMethod @restParameters -Method Get -Uri "$BaseUrl/api/v1/me" -Headers $headers
$risks = Invoke-RestMethod @restParameters -Method Get -Uri "$BaseUrl/api/v1/risks?limit=200" -Headers $headers
$models = @($risks.data | ForEach-Object { $_.model } | Where-Object { $_ } | Sort-Object -Unique)

$compose = Get-ContourComposeArguments -Mode $Mode
if ($Mode -eq "Full") {
    $configuredUrl = (& docker @compose exec -T app python -c "import os; print(os.getenv('ML_PREDICTOR_URL', ''))").Trim()
    if ($LASTEXITCODE -ne 0 -or $configuredUrl -ne "http://ml:8090") {
        throw "Backend полного режима не настроен на внутренний ML-сервис"
    }

    & docker @compose exec -T app python -c "import urllib.request; urllib.request.urlopen('http://ml:8090/health', timeout=5).read()" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Backend не может обратиться к ML /health"
    }

    & docker @compose exec -T app python -c "import json, urllib.request; value=json.load(urllib.request.urlopen('http://ml:8090/quality', timeout=5)); assert 'incident' in value and 'neispraven' in value" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "ML-сервис не отдал проверенный отчёт качества"
    }

    $realModels = @($models | Where-Object { $_ -ne "stub-v1" })
    if ($realModels.Count -eq 0) {
        throw "В полном режиме API не вернул ни одного прогноза реальной ML-модели"
    }
    if ($models -contains "stub-v1") {
        throw "В полном режиме обнаружен прогноз StubPredictor. Используй отдельную чистую БД contour-full"
    }

    $demoClockRisks = @($risks.data | Where-Object { $_.model -ne "stub-v1" -and $null -ne $_.demo_clock })
    $missingDemoClockRisks = @($risks.data | Where-Object { $_.model -ne "stub-v1" -and $null -eq $_.demo_clock })
    if ($demoClockRisks.Count -eq 0) {
        throw "Full API не вернул provenance исторического ML demo_clock"
    }
    if ($missingDemoClockRisks.Count -gt 0) {
        throw "Full API вернул актуальные real-model риски без demo_clock: $($missingDemoClockRisks.id -join ', ')"
    }
    foreach ($risk in $demoClockRisks) {
        $modelAsOf = ConvertTo-ContourDateTimeOffset -Value $risk.as_of -FieldName "risk.as_of"
        $anchor = ConvertTo-ContourDateTimeOffset -Value $risk.demo_clock.anchor_utc -FieldName "risk.demo_clock.anchor_utc"
        $requested = ConvertTo-ContourDateTimeOffset -Value $risk.demo_clock.requested_as_of_utc -FieldName "risk.demo_clock.requested_as_of_utc"
        $windowStart = ConvertTo-ContourDateTimeOffset -Value $risk.prediction_window.start -FieldName "risk.prediction_window.start"
        if ($modelAsOf -lt $anchor -or $modelAsOf -gt $requested -or $windowStart -lt $modelAsOf) {
            throw "Full API нарушил разделение model clock и operational wall-clock для риска $($risk.id)"
        }
    }

    & docker @compose exec -T app python -m scripts.check-risk-provenance *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "В Full БД есть неинвалидированные real-model риски без demo_clock"
    }
}
else {
    $configuredUrl = (& docker @compose exec -T app python -c "import os; print(os.getenv('ML_PREDICTOR_URL', ''))").Trim()
    if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($configuredUrl)) {
        throw "Lite-режим неожиданно настроен на внешний ML-сервис"
    }
}

$docs = Invoke-WebRequest @webParameters -Method Get -Uri "$BaseUrl/docs"
if ($docs.StatusCode -ne 200 -or $docs.Content -notmatch 'id="swagger-ui"' -or $docs.Content -notmatch "/docs-assets/swagger-ui-bundle.js") {
    throw "Локальная Swagger UI не загрузилась"
}
if ($docs.Content -match "https?://") {
    throw "Swagger UI содержит внешний runtime-ресурс и будет нарушать CSP"
}
$swaggerBundle = Invoke-WebRequest @webParameters -Method Get -Uri "$BaseUrl/docs-assets/swagger-ui-bundle.js"
if ($swaggerBundle.StatusCode -ne 200 -or $swaggerBundle.Content.Length -lt 100000) {
    throw "Локальный Swagger UI bundle недоступен"
}
$swaggerInitializer = Invoke-WebRequest @webParameters -Method Get -Uri "$BaseUrl/docs-assets/swagger-initializer.js"
if ($swaggerInitializer.StatusCode -ne 200 -or $swaggerInitializer.Content -notmatch "SwaggerUIBundle") {
    throw "Локальный Swagger initializer недоступен"
}

& docker @compose exec -T app python /app/scripts/concurrency-smoke.py --users 20
if ($LASTEXITCODE -ne 0) {
    throw "Проверка 20 одновременных авторизованных сессий не пройдена"
}

Invoke-RestMethod @restParameters -Method Post -Uri "$BaseUrl/api/v1/auth/logout" -Headers $headers | Out-Null

Write-Host "OK: frontend, backend health, auth, /me и /risks" -ForegroundColor Green
Write-Host "Пользователь: $($me.display_name) ($($me.role))"
Write-Host "Модели: $(if ($models.Count) { $models -join ', ' } else { 'рисков пока нет' })"
Write-Host "Конкурентность: 20 независимых сессий пяти ролей" -ForegroundColor Green
