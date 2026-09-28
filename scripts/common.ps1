Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ContourRoot = Split-Path -Parent $PSScriptRoot
$script:FullProjectName = "contour-full"
$script:LiteProjectName = "contour-lite"

function Get-ContourDotEnvValue {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $envFile = Join-Path $script:ContourRoot ".env"
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return $null
    }

    foreach ($line in Get-Content -LiteralPath $envFile) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed.StartsWith("export ")) {
            $trimmed = $trimmed.Substring(7).TrimStart()
        }

        $separator = $trimmed.IndexOf("=")
        if ($separator -lt 1) {
            continue
        }
        if ($trimmed.Substring(0, $separator).Trim() -ne $Name) {
            continue
        }

        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        return $value
    }

    return $null
}

function Get-ContourEnvironmentValue {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [string]$DefaultValue = ""
    )

    $processValue = [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        return $processValue
    }

    $dotEnvValue = Get-ContourDotEnvValue -Name $Name
    if (-not [string]::IsNullOrWhiteSpace($dotEnvValue)) {
        return $dotEnvValue
    }

    return $DefaultValue
}

function Assert-DockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI не найден. Установи и запусти Docker Desktop"
    }

    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose v2 недоступен. Обнови Docker Desktop"
    }

    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Engine недоступен. Запусти Docker Desktop и дождись готовности Linux engine"
    }
}

function Get-ContourComposeArguments {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("Full", "Lite")]
        [string]$Mode
    )

    $baseFile = Join-Path $script:ContourRoot "docker-compose.yml"
    $common = @("compose", "--project-directory", $script:ContourRoot)
    $envFile = Join-Path $script:ContourRoot ".env"
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $common += @("--env-file", $envFile)
    }
    if ($Mode -eq "Full") {
        return $common + @(
            "--project-name", $script:FullProjectName,
            "-f", $baseFile,
            "-f", (Join-Path $script:ContourRoot "docker-compose.ml.yml")
        )
    }

    return $common + @(
        "--project-name", $script:LiteProjectName,
        "-f", $baseFile
    )
}

function Invoke-ContourDocker {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Команда docker завершилась с кодом $LASTEXITCODE"
    }
}

function Resolve-ContourMlDataDirectory {
    param([string]$Path)

    $candidate = $Path
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Get-ContourEnvironmentValue -Name "ML_DATA_DIR"
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Join-Path $script:ContourRoot "ml-data"
    }
    elseif (-not [System.IO.Path]::IsPathRooted($candidate)) {
        # Compose resolves relative bind-mount values against the project
        # directory. Resolve the script-side validation the same way.
        $candidate = Join-Path $script:ContourRoot $candidate
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw "Каталог ML-данных не найден: $candidate"
    }

    return (Resolve-Path -LiteralPath $candidate).Path
}

function Test-ParquetMagic {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 12) {
            return $false
        }

        $start = [byte[]]::new(4)
        $finish = [byte[]]::new(4)
        [void]$stream.Read($start, 0, 4)
        [void]$stream.Seek(-4, [System.IO.SeekOrigin]::End)
        [void]$stream.Read($finish, 0, 4)
        return ([System.Text.Encoding]::ASCII.GetString($start) -eq "PAR1" -and
            [System.Text.Encoding]::ASCII.GetString($finish) -eq "PAR1")
    }
    finally {
        $stream.Dispose()
    }
}

function Assert-ContourMlData {
    param([string]$Path)

    $resolved = Resolve-ContourMlDataDirectory -Path $Path
    $problems = [System.Collections.Generic.List[string]]::new()

    foreach ($year in 2019..2026) {
        $file = Join-Path $resolved "$year.parquet"
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            $problems.Add("нет файла $year.parquet")
            continue
        }
        if (-not (Test-ParquetMagic -Path $file)) {
            $problems.Add("$year.parquet не похож на корректный Parquet-файл")
        }
    }

    if ($problems.Count -gt 0) {
        $details = $problems -join [Environment]::NewLine
        throw "Полный ML-режим не запущен. Исправь каталог $resolved`n$details"
    }

    return $resolved
}

function Get-ContourBaseUrl {
    $httpsPort = Get-ContourEnvironmentValue -Name "HTTPS_PORT" -DefaultValue "8443"
    return "https://localhost:$httpsPort"
}
