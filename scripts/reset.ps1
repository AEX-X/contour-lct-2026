param(
    [ValidateSet("Full", "Lite", "All")]
    [string]$Mode = "All",
    [switch]$Force
)

. (Join-Path $PSScriptRoot "common.ps1")

if (-not $Force) {
    throw "Reset удалит БД и локальный TLS-сертификат выбранного режима. Повтори команду с -Force"
}

Assert-DockerReady
$modes = if ($Mode -eq "All") { @("Full", "Lite") } else { @($Mode) }

foreach ($currentMode in $modes) {
    $compose = Get-ContourComposeArguments -Mode $currentMode
    Invoke-ContourDocker -Arguments ($compose + @("down", "--volumes", "--remove-orphans"))
}

Write-Host "Состояние Contour сброшено. Файлы в ml-data не изменялись" -ForegroundColor Green
