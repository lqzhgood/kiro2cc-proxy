# Kiro IDE local import. Windows PowerShell 5.1+; no external dependencies.
param(
    [Parameter(Mandatory = $true)][string]$ServerOrigin,
    [Parameter(Mandatory = $true)][string]$ImportToken,
    [string]$Email
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Read-Field($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return '' }
    if ($property.Value -isnot [string]) { throw "Invalid Kiro cache field: $Name" }
    return $property.Value.Trim()
}

function Invoke-ImportRequest([string]$Method, [byte[]]$Body) {
    $options = @{
        Uri = "$($ServerOrigin.TrimEnd('/'))/api/admin/fork/import-session"
        Method = $Method
        Headers = @{ 'x-kiro-import-token' = $ImportToken }
        MaximumRedirection = 0
        TimeoutSec = 30
        ErrorAction = 'Stop'
    }
    if ($Method -eq 'Post') { $options.Body = $Body; $options.ContentType = 'application/json; charset=utf-8' }
    Invoke-RestMethod @options
}

try {
    $uri = [uri]$ServerOrigin
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'Invalid server origin.'
    }
    if ($ImportToken -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid import grant. Copy a new command from the admin page.' }
    $dataRoot = if ($env:KIRO_EXPORT_ROOT) { $env:KIRO_EXPORT_ROOT } else { [Environment]::GetFolderPath('UserProfile') }
    $cache = Join-Path $dataRoot '.aws/sso/cache'
    try { $account = Get-Content -LiteralPath (Join-Path $cache 'kiro-auth-token.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'Cannot read Kiro IDE login cache. Sign in to Kiro IDE first.' }
    $refresh = Read-Field $account 'refreshToken'
    if (-not $refresh) { throw 'No refresh token. Sign in to Kiro IDE again.' }
    $method = (Read-Field $account 'authMethod').ToLowerInvariant()
    if (-not $method) { $method = 'idc' }
    if ($method -notin @('social', 'idc')) { throw 'This login type requires manual import.' }
    $region = Read-Field $account 'region'
    if (-not $region) { $region = 'us-east-1' }
    $payload = @{ refreshToken = $refresh; authMethod = $method; authRegion = $region; apiRegion = $region }
    $profile = Read-Field $account 'profileArn'
    if ($profile) { $payload.profileArn = $profile }
    if ($method -eq 'idc') {
        $hash = Read-Field $account 'clientIdHash'
        if ($hash -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Missing or invalid clientIdHash. Sign in to Kiro IDE again.' }
        try { $registration = Get-Content -LiteralPath (Join-Path $cache "$hash.json") -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { throw 'The matching client registration is missing. Sign in to Kiro IDE again.' }
        $payload.clientId = Read-Field $registration 'clientId'
        $payload.clientSecret = Read-Field $registration 'clientSecret'
        if (-not $payload.clientId -or -not $payload.clientSecret) { throw 'Incomplete client registration. Sign in to Kiro IDE again.' }
    }
    $appData = if ($env:KIRO_EXPORT_ROOT) { Join-Path $dataRoot 'AppData/Roaming' } else { [Environment]::GetFolderPath('ApplicationData') }
    $machineFile = Join-Path $appData 'Kiro/machineid'
    if (Test-Path -LiteralPath $machineFile) {
        $machineId = (Get-Content -LiteralPath $machineFile -Raw -Encoding UTF8).Trim()
        if ($machineId) { $payload.machineId = $machineId }
    }
    if ($PSBoundParameters.ContainsKey('Email')) {
        if ($Email -notmatch '^[^\s@]+@[^\s@]+$') { throw 'A valid email is required.' }
    } else {
        do { $Email = Read-Host 'Account email (required)' } while ($Email -notmatch '^[^\s@]+@[^\s@]+$')
    }
    $payload.email = $Email
    $body = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
    # Do not echo credentials or raw HTTP errors, even when the POST response is lost.
    Write-Host "Importing into $ServerOrigin ..."
    try { $result = Invoke-ImportRequest 'Post' $body } catch { $result = $null }
    for ($attempt = 0; $attempt -lt 300; $attempt++) {
        $status = if ($null -ne $result) { Read-Field $result 'status' } else { '' }
        switch ($status) {
            'success' { Write-Host "Imported and enabled ($Email)."; return }
            'duplicate' { Write-Host 'Account already exists; skipped.'; return }
            'failed' { throw 'Import failed. Check the login and generate a new command.' }
            'unverified' { throw 'Imported but verification failed. The account remains disabled; check the admin page.' }
            'activationUnknown' { throw 'Imported and verified; activation is unconfirmed. Check the admin page.' }
            'awaiting' { throw 'Upload was not accepted. Rerun the same command, or generate a new one if expired.' }
            'running' { }
            '' { }
            default { throw 'Cannot confirm import result. Check the admin page.' }
        }
        Start-Sleep -Seconds 2
        try { $result = Invoke-ImportRequest 'Get' $null }
        catch { throw 'Cannot query result (network error or expired grant). Check the admin page before retrying.' }
    }
    throw 'Timed out waiting; the server may still be importing. Check the admin page.'
} catch {
    # Only errors constructed above reach the terminal; cache/HTTP bodies stay private.
    Write-Host 'Kiro import did not complete. Check the admin page and local Kiro login.'
    throw
}
