param(
    [ValidateSet("Full", "Lite", "All")]
    [string]$Mode = "All"
)

. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady
$modes = if ($Mode -eq "All") { @("Full", "Lite") } else { @($Mode) }

foreach ($currentMode in $modes) {
    $compose = Get-ContourComposeArguments -Mode $currentMode
    Invoke-ContourDocker -Arguments ($compose + @("down", "--remove-orphans"))
}

Write-Host "Contour остановлен. Данные PostgreSQL и сертификаты сохранены" -ForegroundColor Green
