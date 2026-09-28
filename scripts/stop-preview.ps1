. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady

$previewFile = Join-Path $script:ContourRoot "docker-compose.preview.yml"
$composeArgs = (Get-ContourComposeArguments -Mode Full) + @("-f", $previewFile)

& docker @composeArgs rm -f -s preview preview-gateway
if ($LASTEXITCODE -ne 0) {
    throw "Не удалось остановить preview-туннель"
}

Write-Host "Публичный preview-туннель остановлен" -ForegroundColor Green
