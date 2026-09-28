param(
    [ValidateSet("Full", "Lite")]
    [string]$Mode = "Lite"
)

. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady

$composeArgs = Get-ContourComposeArguments -Mode $Mode
$dbUserOutput = & docker @composeArgs exec -T db printenv POSTGRES_USER
if ($LASTEXITCODE -ne 0) {
    throw "Контейнер PostgreSQL режима $Mode не запущен"
}
$dbNameOutput = & docker @composeArgs exec -T db printenv POSTGRES_DB
if ($LASTEXITCODE -ne 0) {
    throw "Не удалось определить основную базу PostgreSQL"
}
$dbPasswordOutput = & docker @composeArgs exec -T db printenv POSTGRES_PASSWORD
if ($LASTEXITCODE -ne 0) {
    throw "Не удалось определить пароль PostgreSQL"
}

$dbUser = ($dbUserOutput | Select-Object -First 1).Trim()
$primaryDb = ($dbNameOutput | Select-Object -First 1).Trim()
$dbPassword = ($dbPasswordOutput | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($dbUser) -or
    [string]::IsNullOrWhiteSpace($primaryDb) -or
    [string]::IsNullOrWhiteSpace($dbPassword)) {
    throw "Контейнер PostgreSQL вернул неполную конфигурацию"
}

$testDb = "contour_test_$([guid]::NewGuid().ToString('N'))"
$testDbCreated = $false

try {
    Write-Host "Создание временной базы $testDb" -ForegroundColor Cyan
    Invoke-ContourDocker -Arguments ($composeArgs + @(
        "exec", "-T", "db", "createdb", "-U", $dbUser, $testDb
    ))
    $testDbCreated = $true

    $encodedUser = [uri]::EscapeDataString($dbUser)
    $encodedPassword = [uri]::EscapeDataString($dbPassword)
    $testUrl = "postgresql+asyncpg://${encodedUser}:${encodedPassword}@db:5432/$testDb"

    Write-Host "Применение миграций" -ForegroundColor Cyan
    Invoke-ContourDocker -Arguments ($composeArgs + @(
        "exec", "-T",
        "-e", "DATABASE_URL=$testUrl",
        "-e", "ML_PREDICTOR_URL=",
        "app", "alembic", "upgrade", "head"
    ))

    Write-Host "Запуск backend-тестов" -ForegroundColor Cyan
    Invoke-ContourDocker -Arguments ($composeArgs + @(
        "exec", "-T",
        "-e", "DATABASE_URL=$testUrl",
        "-e", "ML_PREDICTOR_URL=",
        "app", "pytest", "-q"
    ))
}
finally {
    if ($testDbCreated) {
        Write-Host "Удаление временной базы $testDb" -ForegroundColor DarkGray
        & docker @composeArgs exec -T db psql -U $dbUser -d $primaryDb -v ON_ERROR_STOP=1 -c (
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
            "WHERE datname = '$testDb' AND pid <> pg_backend_pid();"
        ) *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Не удалось завершить подключения к временной базе $testDb"
        }

        & docker @composeArgs exec -T db dropdb -U $dbUser --if-exists $testDb
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Не удалось удалить временную базу $testDb"
        }
    }
}

Write-Host "Backend-тесты пройдены" -ForegroundColor Green
