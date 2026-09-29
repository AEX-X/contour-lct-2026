param(
    [int]$ReadyTimeoutSeconds = 120
)

. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady

$previewFile = Join-Path $script:ContourRoot "docker-compose.preview.yml"
$composeArgs = (Get-ContourComposeArguments -Mode Full) + @("-f", $previewFile)
$baseUrl = Get-ContourBaseUrl

function Get-PreviewUrl {
    param(
        [string[]]$LogLines
    )

    $addresses = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $LogLines) {
        try {
            $event = $line | ConvertFrom-Json -ErrorAction Stop
            if ($event.event -eq "tcpip-forward" -and
                $event.status -eq "success" -and
                $event.tls_termination -eq $true -and
                -not [string]::IsNullOrWhiteSpace($event.address)) {
                [void]$addresses.Add("https://$($event.address)")
            }
        }
        catch {
            # localhost.run also writes human-readable connection diagnostics.
        }
    }

    if ($addresses.Count -eq 0) {
        return $null
    }
    return $addresses[$addresses.Count - 1]
}

function Test-PreviewUrl {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 10
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    try {
        $publicHealth = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec $TimeoutSeconds
        return $publicHealth.status -eq "ok"
    }
    catch {
        return $false
    }
}

function Test-PreviewApiSession {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 15
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    $token = $null
    try {
        $loginBody = @{ username = "manager"; password = "manager123" } | ConvertTo-Json
        $session = Invoke-RestMethod `
            -Method Post `
            -Uri "$Url/api/v1/auth/login" `
            -ContentType "application/json" `
            -Body $loginBody `
            -TimeoutSec $TimeoutSeconds
        $token = [string]$session.token
        if ([string]::IsNullOrWhiteSpace($token)) {
            return $false
        }

        $headers = @{ Authorization = "Bearer $token" }
        $currentUser = Invoke-RestMethod `
            -Method Get `
            -Uri "$Url/api/v1/me" `
            -Headers $headers `
            -TimeoutSec $TimeoutSeconds
        return $currentUser.role -eq "manager"
    }
    catch {
        return $false
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($token)) {
            try {
                Invoke-RestMethod `
                    -Method Post `
                    -Uri "$Url/api/v1/auth/logout" `
                    -Headers @{ Authorization = "Bearer $token" } `
                    -TimeoutSec $TimeoutSeconds | Out-Null
            }
            catch {
                # A failed cleanup must not hide the readiness result.
            }
        }
    }
}

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
    # Start only the two preview services. The Full stack was checked above
    # and must not be recreated here. Anonymous localhost.run routes are
    # short-lived, so every explicit start gets a fresh tunnel and URL.
    Invoke-ContourDocker -Arguments ($composeArgs + @(
        "up", "-d", "--no-deps", "--wait", "--wait-timeout", "60", "preview-gateway"
    ))
    Invoke-ContourDocker -Arguments ($composeArgs + @("rm", "-f", "-s", "preview"))
    Invoke-ContourDocker -Arguments ($composeArgs + @("up", "-d", "--no-deps", "preview"))
}
catch {
    & docker @composeArgs rm -f -s preview *> $null
    throw
}

$deadline = [DateTimeOffset]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
$previewUrl = $null
$previewReady = $false
$lastLogs = ""

while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $logLines = & docker @composeArgs logs --no-color --no-log-prefix --tail 100 preview 2>&1
    $lastLogs = $logLines -join [Environment]::NewLine
    $previewUrl = Get-PreviewUrl -LogLines $logLines

    if ((Test-PreviewUrl -Url $previewUrl -TimeoutSeconds 15) -and
        (Test-PreviewApiSession -Url $previewUrl -TimeoutSeconds 15)) {
        $previewReady = $true
        break
    }
    Start-Sleep -Seconds 2
}

if (-not $previewReady) {
    & docker @composeArgs rm -f -s preview *> $null
    throw "Preview-туннель не стал доступен за $ReadyTimeoutSeconds секунд`n$lastLogs"
}

Write-Host "Contour доступен для командной проверки:" -ForegroundColor Green
Write-Host $previewUrl -ForegroundColor Green
Write-Host "Ссылка временная: не выключай этот ПК, Docker, preview и preview-gateway" -ForegroundColor Yellow
Write-Output "PREVIEW_URL=$previewUrl"
