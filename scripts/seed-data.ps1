param(
    [string]$BaseUrl = "http://localhost:8080",
    [string]$AuthUrl = "http://localhost:8010",
    [string]$Email = "admin@atlas.io",
    [string]$Password = "ChangeMe123!",
    [string]$PayrollPeriod = "",
    [int]$EmployeeCount = 20
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrEmpty($PayrollPeriod)) {
    $PayrollPeriod = (Get-Date).AddMonths(-1).ToString("yyyy-MM")
}

$script:failures = 0
$script:skipped = 0

$loginTmp = "$env:TEMP\seed_login.json"
$bodyTmp = "$env:TEMP\seed_body_$([Guid]::NewGuid().ToString('N')).json"
$respTmp = "$env:TEMP\seed_resp_$([Guid]::NewGuid().ToString('N')).json"

function Remove-TempFiles {
    foreach ($f in @($loginTmp, $bodyTmp, $respTmp)) {
        if ($f -and (Test-Path $f)) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
}

function Read-ResponseBody {
    if (Test-Path $respTmp) {
        $c = Get-Content -Path $respTmp -Raw -ErrorAction SilentlyContinue
        if ($null -eq $c) { return "" }
        return $c
    }
    return ""
}

function Get-Token {
    param($Email, $Password)
    $loginBody = @{ email = $Email; password = $Password } | ConvertTo-Json -Compress
    Set-Content -Path $loginTmp -Value $loginBody -Encoding Ascii
    $code = (& curl.exe -s -o $respTmp -w '%{http_code}' -X POST "$AuthUrl/login" -H "Content-Type: application/json" --data-binary "@$loginTmp").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Login request failed (curl exit $LASTEXITCODE). Is the auth service up at $AuthUrl?"
    }
    if ([int]$code -lt 200 -or [int]$code -ge 300) {
        throw "Login failed with HTTP $code : $(Read-ResponseBody)"
    }
    $token = ((Read-ResponseBody) | ConvertFrom-Json).token
    if ([string]::IsNullOrEmpty($token)) {
        throw "Login returned HTTP $code but no token in the response."
    }
    return $token
}

function Invoke-Api {
    param($Method, $Url, $BodyObject, $Token)
    if ($BodyObject) {
        $json = $BodyObject | ConvertTo-Json -Compress -Depth 5
        Set-Content -Path $bodyTmp -Value $json -Encoding Ascii
        $code = (& curl.exe -s -o $respTmp -w '%{http_code}' -X $Method $Url -H "Content-Type: application/json" -H "Authorization: Bearer $Token" --data-binary "@$bodyTmp").Trim()
    } else {
        $code = (& curl.exe -s -o $respTmp -w '%{http_code}' -X $Method $Url -H "Authorization: Bearer $Token").Trim()
    }
    if ($LASTEXITCODE -ne 0) {
        throw "curl failed with exit code $LASTEXITCODE for $Method $Url"
    }
    return @{ StatusCode = [int]$code; Body = (Read-ResponseBody) }
}

function Test-Duplicate($Response) {
    return ($Response.StatusCode -eq 409) -or ($Response.Body -match 'already exists')
}

try {
    $token = Get-Token -Email $Email -Password $Password
    Write-Output "Token: $($token.Substring(0, [Math]::Min(20, $token.Length)))..."

    $departments = @("Engineering","Sales","Marketing","Finance","Human Resources","Operations")
    $positions = @{
        "Engineering"       = @("Software Engineer","Senior Developer","Frontend Developer","Backend Developer","DevOps Engineer","Tech Lead","Engineering Manager")
        "Sales"             = @("Sales Representative","Account Manager","Sales Director","Business Development")
        "Marketing"         = @("Marketing Specialist","Content Writer","Marketing Manager","SEO Analyst")
        "Finance"           = @("Financial Analyst","Accountant","Finance Manager","CFO")
        "Human Resources"   = @("HR Coordinator","Recruiter","HR Manager","HR Director")
        "Operations"        = @("Operations Analyst","Operations Manager","Logistics Coordinator","COO")
    }

    $firstNames = @("Sarah","James","Maria","David","Emily","Michael","Jessica","Robert","Amy","William","Jennifer","Daniel","Lisa","John","Michelle","Christopher")
    $lastNames  = @("Chen","Wilson","Garcia","Kim","Johnson","Brown","Davis","Miller","Anderson","Taylor","Thomas","Jackson","White","Harris","Martin","Thompson")

    $employees = @()
    $employeeIds = @()
    $empCount = 0

    Write-Output "`n=== Creating $EmployeeCount Employees ==="
    for ($i = 0; $i -lt $EmployeeCount; $i++) {
        $first = $firstNames[$i % $firstNames.Length]
        $last  = $lastNames[$i % $lastNames.Length]
        $dept  = $departments[$i % $departments.Length]
        $pos   = $positions[$dept][$i % $positions[$dept].Length]
        $email = "$($first.ToLower()).$($last.ToLower())$($i)@atlas.io"
        $empBody = @{ name = "$first $last"; email = $email; department = $dept; position = $pos }

        try {
            $result = Invoke-Api -Method POST -Url "$BaseUrl/api/employee/employees" -BodyObject $empBody -Token $token
            if ($result.StatusCode -ge 200 -and $result.StatusCode -lt 300) {
                Write-Output "  [$($i+1)/$EmployeeCount] $first $last ($dept - $pos)"
                $employees += @{Name="$first $last"; Email=$email; Dept=$dept}
                $employeeIds += $email
                $empCount++
            } elseif (Test-Duplicate $result) {
                Write-Output "  [SKIP] $email (already exists)"
                $script:skipped++
                $employeeIds += $email
            } else {
                Write-Output "  [FAIL] $email (HTTP $($result.StatusCode): $($result.Body))"
                $script:failures++
            }
        } catch {
            Write-Output "  [FAIL] $email ($($_.Exception.Message))"
            $script:failures++
        }
        Start-Sleep -Milliseconds 50
    }

    Write-Output "`n=== Creating Leave Requests ==="
    $leaveTypes = @("VACATION","SICK","PERSONAL")
    $today = Get-Date
    $leaveCount = 0

    for ($i = 0; $i -lt [Math]::Min(12, $employeeIds.Count); $i++) {
        $empEmail = $employeeIds[$i]
        $leaveType = $leaveTypes[$i % $leaveTypes.Length]
        $days = 1..5 | Get-Random
        $startDate = $today.AddDays(-20 + $i * 2).ToString("yyyy-MM-dd")
        $endDate = $today.AddDays(-20 + $i * 2 + $days - 1).ToString("yyyy-MM-dd")

        $leaveBody = @{ employeeId = $empEmail; startDate = $startDate; endDate = $endDate; leaveType = $leaveType; reason = "Seeded leave request $($i+1)" }

        try {
            $result = Invoke-Api -Method POST -Url "$BaseUrl/api/leave/request" -BodyObject $leaveBody -Token $token
            if ($result.StatusCode -ge 200 -and $result.StatusCode -lt 300) {
                Write-Output "  Leave: $empEmail - $leaveType ($startDate to $endDate)"
                $leaveCount++
            } elseif (Test-Duplicate $result) {
                Write-Output "  [SKIP] Leave for $empEmail (already exists)"
                $script:skipped++
            } else {
                Write-Output "  [FAIL] Leave for $empEmail (HTTP $($result.StatusCode): $($result.Body))"
                $script:failures++
            }
        } catch {
            Write-Output "  [FAIL] Leave for $empEmail ($($_.Exception.Message))"
            $script:failures++
        }
        Start-Sleep -Milliseconds 50
    }

    Write-Output "`n=== Creating Attendance Records ==="
    $attCount = 0
    for ($i = 0; $i -lt [Math]::Min(15, $employeeIds.Count); $i++) {
        $empEmail = $employeeIds[$i]
        $daysBack = Get-Random -Minimum 0 -Maximum 14
        $clockDate = $today.AddDays(-$daysBack).ToString("yyyy-MM-dd")

        $attBody = @{ employeeId = $empEmail; localDate = $clockDate }

        try {
            $result = Invoke-Api -Method POST -Url "$BaseUrl/api/attendance/clock-in" -BodyObject $attBody -Token $token
            if ($result.StatusCode -ge 200 -and $result.StatusCode -lt 300) {
                Write-Output "  Clock-in: $empEmail on $clockDate"
                $attCount++
            } elseif (Test-Duplicate $result) {
                Write-Output "  [SKIP] Clock-in for $empEmail (already exists)"
                $script:skipped++
            } else {
                Write-Output "  [FAIL] Clock-in for $empEmail (HTTP $($result.StatusCode): $($result.Body))"
                $script:failures++
            }
        } catch {
            Write-Output "  [FAIL] Clock-in for $empEmail ($($_.Exception.Message))"
            $script:failures++
        }
        Start-Sleep -Milliseconds 50

        if ((Get-Random -Max 2) -eq 0) {
            try {
                $result = Invoke-Api -Method POST -Url "$BaseUrl/api/attendance/clock-out" -BodyObject $attBody -Token $token
                if ($result.StatusCode -ge 200 -and $result.StatusCode -lt 300) {
                    Write-Output "  Clock-out: $empEmail on $clockDate"
                } elseif (Test-Duplicate $result) {
                    Write-Output "  [SKIP] Clock-out for $empEmail (already exists)"
                    $script:skipped++
                } else {
                    Write-Output "  [FAIL] Clock-out for $empEmail (HTTP $($result.StatusCode): $($result.Body))"
                    $script:failures++
                }
            } catch {
                Write-Output "  [FAIL] Clock-out for $empEmail ($($_.Exception.Message))"
                $script:failures++
            }
            Start-Sleep -Milliseconds 50
        }
    }

    Write-Output "`n=== Running Payroll ==="
    $payCount = 0
    for ($i = 0; $i -lt [Math]::Min(10, $employeeIds.Count); $i++) {
        $empEmail = $employeeIds[$i]
        $baseSalary = 5000 + (Get-Random -Maximum 5000)
        $allowances = Get-Random -Maximum 800
        $deductions = Get-Random -Maximum 400

        $payBody = @{ employeeId = $empEmail; period = $PayrollPeriod; baseSalary = $baseSalary; allowances = $allowances; deductions = $deductions }

        try {
            $result = Invoke-Api -Method POST -Url "$BaseUrl/api/payroll/run" -BodyObject $payBody -Token $token
            if ($result.StatusCode -ge 200 -and $result.StatusCode -lt 300) {
                Write-Output "  Payroll: $empEmail - period $PayrollPeriod (base: $baseSalary)"
                $payCount++
            } elseif (Test-Duplicate $result) {
                Write-Output "  [SKIP] Payroll for $empEmail (already exists)"
                $script:skipped++
            } else {
                Write-Output "  [FAIL] Payroll for $empEmail (HTTP $($result.StatusCode): $($result.Body))"
                $script:failures++
            }
        } catch {
            Write-Output "  [FAIL] Payroll for $empEmail ($($_.Exception.Message))"
            $script:failures++
        }
        Start-Sleep -Milliseconds 50
    }

    Write-Output "`n=== Seed Complete ==="
    Write-Output "  Employees: $empCount"
    Write-Output "  Leave Requests: $leaveCount"
    Write-Output "  Attendance Records: $attCount"
    Write-Output "  Payroll Runs: $payCount"
    Write-Output "  Skipped (already exists): $($script:skipped)"
    Write-Output "  Failures: $($script:failures)"
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-TempFiles
}

if ($script:failures -gt 0) {
    Write-Output "ERROR: Seed completed with $($script:failures) failures."
    exit 1
}
