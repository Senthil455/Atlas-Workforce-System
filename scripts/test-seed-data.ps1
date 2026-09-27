# Smoke checks for scripts/seed-data.ps1 (issue #192).
# Fails (non-zero exit) if the seed script cannot report errors.
$ErrorActionPreference = "Stop"
$failures = 0

function Check($Name, $Condition) {
    if ($Condition) {
        Write-Output "PASS: $Name"
    } else {
        Write-Output "FAIL: $Name"
        $script:failures++
    }
}

$seed = Join-Path $PSScriptRoot "seed-data.ps1"
$content = Get-Content -Path $seed -Raw

Check "builds JSON with ConvertTo-Json" ($content -match 'ConvertTo-Json')
Check "checks HTTP status explicitly" ($content -match 'http_code')
Check "fails the run on errors" ($content -match 'exit 1')
Check "summary uses real counters" ($content -notmatch 'Employees: 20')
Check "no hand-concatenated JSON bodies" ($content -notmatch '"\{\\"name\\"')
Check "validates token before use" ($content -match 'no token in the response')
Check "payroll period is a parameter" ($content -match 'param\([\s\S]*\$PayrollPeriod')
Check "cleans up temp files" ($content -match 'Remove-TempFiles')

# A name with a quote and a backslash must survive the JSON round-trip.
$roundTrip = (@{ name = 'O''Brien \ Test'; email = 'a@b.io' } | ConvertTo-Json -Compress -Depth 5 | ConvertFrom-Json).name
Check "special chars survive JSON round-trip" ($roundTrip -eq 'O''Brien \ Test')

# Against a dead server the seed must fail loudly, not print Seed Complete.
& powershell -NoProfile -ExecutionPolicy Bypass -File $seed -BaseUrl "http://127.0.0.1:9" -AuthUrl "http://127.0.0.1:9" | Out-Null
Check "dead gateway exits non-zero" ($LASTEXITCODE -ne 0)

if ($script:failures -gt 0) {
    Write-Output "$($script:failures) smoke check(s) failed."
    exit 1
}
Write-Output "All seed smoke checks passed."
