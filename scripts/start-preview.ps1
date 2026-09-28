param(
    [int]$ReadyTimeoutSeconds = 120
)

. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady

$previewFile = Join-Path $script:ContourRoot "docker-compose.preview.yml"
$composeArgs = (Get-ContourComposeArguments -Mode Full) + @("-f", $previewFile)
$baseUrl = Get-ContourBaseUrl

try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -SkipCertificateCheck -TimeoutSec 10
}
catch {
    throw "Full-контур недоступен по $baseUrl. Сначала выполни .\scripts\start-full.ps1"
}
if ($health.status -ne "ok") {
    throw "Full-контур ответил неготовым статусом: $($health.status)"
}

Write-Host "Запуск временного публичного preview-туннеля" -ForegroundColor Cyan
try {
    # Start only the two preview services. Compose builds the tunnel image on
    # the first run; an already running tunnel keeps its current public URL.
    # The Full stack was checked above and must not be recreated here.
    Invoke-ContourDocker -Arguments ($composeArgs + @(
        "up", "-d", "--no-deps", "--wait", "--wait-timeout", "60", "preview-gateway"
    ))
    Invoke-ContourDocker -Arguments ($composeArgs + @("up", "-d", "--no-deps", "preview"))
}
catch {
    & docker @composeArgs rm -f -s preview preview-gateway *> $null
    throw
}

$deadline = [DateTimeOffset]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
$previewUrl = $null
$lastLogs = ""

while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $logLines = & docker @composeArgs logs --no-color --no-log-prefix --tail 100 preview 2>&1
    $lastLogs = $logLines -join [Environment]::NewLine
    foreach ($line in $logLines) {
        try {
            $event = $line | ConvertFrom-Json -ErrorAction Stop
            if ($event.event -eq "tcpip-forward" -and
                $event.status -eq "success" -and
                $event.tls_termination -eq $true -and
                -not [string]::IsNullOrWhiteSpace($event.address)) {
                $previewUrl = "https://$($event.address)"
                break
            }
        }
        catch {
            # localhost.run also writes human-readable connection diagnostics.
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($previewUrl)) {
        try {
            $publicHealth = Invoke-RestMethod -Uri "$previewUrl/health" -TimeoutSec 15
            if ($publicHealth.status -eq "ok") {
                break
            }
        }
        catch {
            # The hostname can appear in the log a few seconds before the edge route is ready.
        }
    }
    Start-Sleep -Seconds 2
}

if ([string]::IsNullOrWhiteSpace($previewUrl) -or
    [DateTimeOffset]::UtcNow -ge $deadline) {
    & docker @composeArgs rm -f -s preview preview-gateway *> $null
    throw "Preview-туннель не стал доступен за $ReadyTimeoutSeconds секунд`n$lastLogs"
}

Write-Host "Contour доступен для командной проверки:" -ForegroundColor Green
Write-Host $previewUrl -ForegroundColor Green
Write-Host "Ссылка временная: не выключай этот ПК, Docker, preview и preview-gateway" -ForegroundColor Yellow
Write-Output "PREVIEW_URL=$previewUrl"
