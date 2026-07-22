param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3344,
  [string]$PublicUrl = "",
  [string]$TunnelToken = "",
  [switch]$SinToken,
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDirectory = Join-Path $projectRoot "storage\tunnel"
$toolDirectory = Join-Path $projectRoot "storage\tools"
$publicUrlFile = Join-Path $logDirectory "public-url.txt"
$serverProcess = $null
$tunnelProcess = $null

function Read-DotEnvValue([string]$Name) {
  $envFile = Join-Path $projectRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile)) { return "" }

  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return ""
}

function New-AccessToken {
  $bytes = New-Object byte[] 24
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return ([Convert]::ToBase64String($bytes) -replace '[+/=]', '')
}

function Wait-LocalServer([int]$ServerPort, [Diagnostics.Process]$Process) {
  $healthUrl = "http://127.0.0.1:$ServerPort/api/health"
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    if ($Process.HasExited) {
      throw "El servidor local termino antes de iniciar. Revisa storage\tunnel\server-error.log."
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "El servidor local no respondio en $healthUrl."
}

function Wait-QuickTunnelUrl([Diagnostics.Process]$Process, [string[]]$LogFiles) {
  for ($attempt = 0; $attempt -lt 45; $attempt += 1) {
    if ($Process.HasExited) {
      throw "Cloudflare Tunnel termino antes de publicar la app. Revisa storage\tunnel\cloudflared-error.log."
    }
    $content = ($LogFiles | ForEach-Object {
      if (Test-Path -LiteralPath $_) { Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue }
    }) -join "`n"
    $match = [regex]::Match($content, 'https://[a-z0-9-]+\.trycloudflare\.com', 'IgnoreCase')
    if ($match.Success) { return $match.Value.TrimEnd('/') }
    Start-Sleep -Seconds 1
  }
  throw "Cloudflare no entrego una URL publica en 45 segundos."
}

function Wait-PublicUrl([string]$Url, [Diagnostics.Process]$Process) {
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    if ($Process.HasExited) {
      throw "Cloudflare Tunnel termino antes de conectar la URL publica."
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "La URL publica no respondio despues de 90 intentos: $Url"
}

try {
  Set-Location $projectRoot
  New-Item -ItemType Directory -Force -Path $logDirectory, $toolDirectory | Out-Null
  Remove-Item -LiteralPath $publicUrlFile -Force -ErrorAction SilentlyContinue

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js no esta instalado o no esta disponible en PATH." }

  $cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cloudflaredCommand) {
    $cloudflared = $cloudflaredCommand.Source
  } else {
    $cloudflared = Join-Path $toolDirectory "cloudflared.exe"
    if (-not (Test-Path -LiteralPath $cloudflared)) {
      Write-Host "Descargando cloudflared desde Cloudflare..." -ForegroundColor Cyan
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cloudflared
    }
  }

  if (-not $TunnelToken) { $TunnelToken = $env:CLOUDFLARE_TUNNEL_TOKEN }
  if (-not $TunnelToken) { $TunnelToken = Read-DotEnvValue "CLOUDFLARE_TUNNEL_TOKEN" }
  if (-not $PublicUrl) { $PublicUrl = $env:PUBLIC_BASE_URL }
  if (-not $PublicUrl) { $PublicUrl = Read-DotEnvValue "PUBLIC_BASE_URL" }
  $PublicUrl = $PublicUrl.Trim().TrimEnd('/')

  $permanentTunnel = -not [string]::IsNullOrWhiteSpace($TunnelToken)
  if ($permanentTunnel -and $PublicUrl -notmatch '^https://') {
    throw "Un tunel permanente requiere PUBLIC_BASE_URL=https://tu-dominio en .env o -PublicUrl."
  }

  if ($SinToken) {
    $apiToken = "disabled"
  } else {
    $apiToken = $env:API_TOKEN
    if (-not $apiToken) { $apiToken = Read-DotEnvValue "API_TOKEN" }
    if (-not $apiToken -or $apiToken -match '^CAMBIA_') { $apiToken = New-AccessToken }
  }

  $env:PORT = [string]$Port
  $env:HOST = "127.0.0.1"
  $env:API_TOKEN = $apiToken
  $env:PUBLIC_BASE_URL = if ($permanentTunnel) { $PublicUrl } else { "auto" }
  $env:ALLOWED_ORIGIN = if ($permanentTunnel) { $PublicUrl } else { "*" }

  $serverOutput = Join-Path $logDirectory "server.log"
  $serverError = Join-Path $logDirectory "server-error.log"
  $tunnelOutput = Join-Path $logDirectory "cloudflared.log"
  $tunnelError = Join-Path $logDirectory "cloudflared-error.log"
  Remove-Item -LiteralPath $serverOutput, $serverError, $tunnelOutput, $tunnelError -Force -ErrorAction SilentlyContinue

  Write-Host "Iniciando Control de Oficios..." -ForegroundColor Cyan
  $serverProcess = Start-Process -FilePath $node.Source -ArgumentList "src\server\server.js" -WorkingDirectory $projectRoot -RedirectStandardOutput $serverOutput -RedirectStandardError $serverError -WindowStyle Hidden -PassThru
  Wait-LocalServer -ServerPort $Port -Process $serverProcess

  if ($permanentTunnel) {
    $tunnelArguments = @("tunnel", "--no-autoupdate", "run", "--token", $TunnelToken)
  } else {
    $tunnelArguments = @("tunnel", "--protocol", "http2", "--url", "http://127.0.0.1:$Port")
  }
  $tunnelProcess = Start-Process -FilePath $cloudflared -ArgumentList $tunnelArguments -WorkingDirectory $projectRoot -RedirectStandardOutput $tunnelOutput -RedirectStandardError $tunnelError -WindowStyle Hidden -PassThru

  if ($permanentTunnel) {
    Wait-PublicUrl -Url $PublicUrl -Process $tunnelProcess
  } else {
    $PublicUrl = Wait-QuickTunnelUrl -Process $tunnelProcess -LogFiles @($tunnelOutput, $tunnelError)
    Wait-PublicUrl -Url $PublicUrl -Process $tunnelProcess
  }
  Set-Content -LiteralPath $publicUrlFile -Value $PublicUrl -Encoding Ascii
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
  if ($health.publicUrl -ne $PublicUrl) {
    throw "El servidor no publico correctamente la URL HTTPS del tunel."
  }

  Write-Host ""
  Write-Host "CONTROL DE OFICIOS DISPONIBLE" -ForegroundColor Green
  Write-Host "URL publica: $PublicUrl" -ForegroundColor Yellow
  if ($SinToken) {
    Write-Host "Modo presentacion: acceso sin token." -ForegroundColor Yellow
  } else {
    Write-Host "Token de acceso: $apiToken" -ForegroundColor Yellow
  }
  Write-Host ""
  if (-not $SinToken) { Write-Host "Comparte ambos datos con los dispositivos autorizados." }
  Write-Host "Abre la URL y pulsa 'Instalar app'."
  if (-not $permanentTunnel) {
    Write-Host "Aviso: esta URL temporal cambia al reiniciar. Configura un tunel permanente para una app instalada estable." -ForegroundColor DarkYellow
  }
  if ($Check) {
    Write-Host "Validacion completada; cerrando procesos de prueba." -ForegroundColor Green
    return
  }
  Write-Host "Mantenga esta ventana abierta. Ctrl+C detiene el servidor y el tunel."

  while (-not $serverProcess.HasExited -and -not $tunnelProcess.HasExited) {
    Start-Sleep -Seconds 2
  }
  if ($serverProcess.HasExited) { throw "El servidor local se detuvo inesperadamente." }
  throw "Cloudflare Tunnel se detuvo inesperadamente."
} catch {
  Write-Host ""
  Write-Error $_
  exit 1
} finally {
  Remove-Item -LiteralPath $publicUrlFile -Force -ErrorAction SilentlyContinue
  foreach ($process in @($tunnelProcess, $serverProcess)) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
