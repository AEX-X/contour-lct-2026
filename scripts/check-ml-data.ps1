param(
    [string]$MlDataDir
)

. (Join-Path $PSScriptRoot "common.ps1")

$resolved = Assert-ContourMlData -Path $MlDataDir
$files = foreach ($year in 2019..2026) {
    $file = Get-Item -LiteralPath (Join-Path $resolved "$year.parquet")
    [pscustomobject]@{
        Year = $year
        File = $file.Name
        SizeGiB = [math]::Round($file.Length / 1GB, 3)
    }
}

$files | Format-Table -AutoSize
Write-Host "ML-данные проверены: $resolved" -ForegroundColor Green
