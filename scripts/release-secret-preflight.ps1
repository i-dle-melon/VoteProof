# Read-only metadata plus optional hidden validation of operator-held copies.
# Cloudflare cannot return existing Secret values. This never rotates/writes them.
param(
  [ValidateSet('local','production')][string]$Target = 'local',
  [string]$Database,
  [string]$ConfirmDatabaseId,
  [ValidatePattern('^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')][string]$VersionId,
  [switch]$CheckCryptoFormats
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $repo 'node_modules/wrangler/bin/wrangler.js'
$oldLogs = $env:WRANGLER_WRITE_LOGS
$oldMetrics = $env:WRANGLER_SEND_METRICS
$env:WRANGLER_WRITE_LOGS = 'false'
$env:WRANGLER_SEND_METRICS = 'false'
function Read-WranglerJson([string[]]$CliArgs) {
  $raw = & node $wrangler @CliArgs 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'METADATA_CHECK_FAILED' }
  return (($raw -join "`n") | ConvertFrom-Json)
}
function Read-HiddenCopy([string]$Name) {
  $secure = Read-Host "$Name operator-vault copy (hidden; not Cloudflare retrieval)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
}
Push-Location $repo
try {
  $metadataPass = $null
  if ($Target -eq 'production') {
  if ($Database -cne 'voteproof-cases' -or $ConfirmDatabaseId -cne '9e2b885d-66e2-4e4d-b768-4bded261296a' -or -not $VersionId) { throw 'EXPLICIT_PRODUCTION_TARGET_REQUIRED' }
  $secretNames = @(Read-WranglerJson -CliArgs @('secret','list','--name','voteproof') | ForEach-Object { $_.name })
  $version = Read-WranglerJson -CliArgs @('versions','view',$VersionId,'--name','voteproof','--json')
  $bindings = @{}
  foreach ($b in $version.resources.bindings) { $bindings[$b.name] = $b }
  if ($bindings['DB'].type -cne 'd1' -or $bindings['DB'].id -cne $ConfirmDatabaseId) { throw 'DATABASE_BINDING_MISMATCH' }
  $required = @('AUTH_SECRET','AUTH_TOTP_ENCRYPTION_KEY','SUPABASE_SECRET_KEY','MAIL_RELAY_URL','MAIL_RELAY_SECRET','TURNSTILE_SECRET_KEY','CASE_QUERY_KEY_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY')
  $rows = @()
  foreach ($name in $required) { $rows += [pscustomobject]@{name=$name; present=($secretNames -contains $name); format='not retrievable'} }
  foreach ($name in @('AUTH_ORIGIN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','R2_ACCOUNT_ID','R2_BUCKET_NAME')) {
    $value = $bindings[$name].text
    $valid = switch ($name) {
      'AUTH_ORIGIN' { $value -ceq 'https://voteproof.i-dle-melon.workers.dev' }
      'SUPABASE_URL' { $value -ceq 'https://bcezasxxirznpojfrmol.supabase.co' }
      'SUPABASE_PUBLISHABLE_KEY' { $value -is [string] -and $value.Length -ge 16 -and $value -notmatch '\s' }
      'R2_ACCOUNT_ID' { $value -is [string] -and $value -match '^[a-fA-F0-9]{32}$' }
      'R2_BUCKET_NAME' { $value -ceq 'voteproof-proofs' }
    }
    $rows += [pscustomobject]@{name=$name; present=($null -ne $value); format=([bool]$valid)}
    $value = $null
  }
  $rows | ConvertTo-Json -Compress
  $metadataPass = -not ($rows | Where-Object { -not $_.present -or $_.format -eq $false })
  } else {
    if ($Database -or $ConfirmDatabaseId -or $VersionId) { throw 'AMBIGUOUS_LOCAL_TARGET' }
    Write-Output 'LOCAL_COPY_FORMAT_ONLY_NO_CLOUDFLARE_REQUEST'
  }
  $cryptoPass = $null
  if ($CheckCryptoFormats) {
    $authCopy = Read-HiddenCopy 'AUTH_SECRET'
    $totpCopy = Read-HiddenCopy 'AUTH_TOTP_ENCRYPTION_KEY'
    $authOk = $authCopy -cmatch '^[a-fA-F0-9]{64}$'
    $totpOk = $totpCopy -cmatch '^[a-fA-F0-9]{64}$'
    $distinct = $authOk -and $totpOk -and $authCopy.ToLowerInvariant() -cne $totpCopy.ToLowerInvariant()
    [pscustomobject]@{name='AUTH_SECRET';format_valid=$authOk;bytes=$(if($authOk){32}else{$null});source='operator copy only'} | ConvertTo-Json -Compress
    [pscustomobject]@{name='AUTH_TOTP_ENCRYPTION_KEY';format_valid=$totpOk;bytes=$(if($totpOk){32}else{$null});source='operator copy only'} | ConvertTo-Json -Compress
    [pscustomobject]@{name='AUTH_KEY_SEPARATION';valid=$distinct} | ConvertTo-Json -Compress
    $cryptoPass = $authOk -and $totpOk -and $distinct
    $authCopy = $null; $totpCopy = $null
  }
  [pscustomobject]@{target=$Target;metadata_pass=$metadataPass;crypto_copy_format_pass=$cryptoPass;cloudflare_value_match_verified=$false;secrets_written=$false} | ConvertTo-Json -Compress
  if (($Target -eq 'production' -and -not $metadataPass) -or $cryptoPass -eq $false) { exit 1 }
} catch { Write-Output 'SECRET_PREFLIGHT_STOPPED'; exit 1 }
finally {
  $authCopy=$null; $totpCopy=$null; $version=$null; $bindings=$null
  $env:WRANGLER_WRITE_LOGS=$oldLogs; $env:WRANGLER_SEND_METRICS=$oldMetrics
  Pop-Location
}
