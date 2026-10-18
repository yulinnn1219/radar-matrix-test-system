param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode }
}
if (-not $nodePath) { throw 'Node.js 24 or newer is required. Install Node.js and run this launcher again.' }
$nodeVersion = & $nodePath --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw "Node.js 24 or newer is required. Found $nodeVersion" }
$servicePort = if ($env:PORT) { [int]$env:PORT } else { 4318 }
$serviceUrl = "http://127.0.0.1:$servicePort"
try {
    $existing = Invoke-RestMethod -Uri "$serviceUrl/api/health" -TimeoutSec 2
    if ($existing.service -eq 'radar-matrix-test-system') {
        if (-not $NoBrowser) { Start-Process $serviceUrl }
        Write-Host "The system is already running: $serviceUrl"
        exit 0
    }
} catch { }
$serverPath = Join-Path $projectRoot 'server.mjs'
$serverProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($serverProcess.HasExited) { throw 'The service exited during startup. Check whether the port is already in use.' }
        try {
            $health = Invoke-RestMethod -Uri "$serviceUrl/api/health" -TimeoutSec 1
            if ($health.service -eq 'radar-matrix-test-system') { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'The service did not become ready. Run node server.mjs in a terminal to see diagnostics.' }
    if (-not $NoBrowser) { Start-Process $serviceUrl }
    Write-Host "Matrix Test System is running: $serviceUrl"
    Write-Host 'Keep this window open. Press Ctrl+C to stop the local service.'
    while (-not $serverProcess.HasExited) { Start-Sleep -Milliseconds 500 }
} finally {
    if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue }
}
