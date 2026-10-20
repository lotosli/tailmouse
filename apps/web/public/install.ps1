param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'TailMouse\bin'))
$ErrorActionPreference = 'Stop'
$Version = '1.0.0'
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') { throw 'This installer is for Windows. Use https://tailmouse.com/install.sh on macOS or Linux.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$Arch = switch ($Architecture.ToUpperInvariant()) { 'AMD64' { 'amd64' } 'ARM64' { 'arm64' } default { throw 'Supported processors: x64 and ARM64.' } }
$Archive = "tailmouse_${Version}_windows_${Arch}.zip"
$Base = "https://github.com/lotosli/tailmouse/releases/download/v$Version"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Temporary = Join-Path $InstallDir ('.tailmouse-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temporary | Out-Null
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Temporary 'SHA256SUMS')
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "$Base/$Archive" -OutFile (Join-Path $Temporary 'archive.zip')
    $Checksums = @(Get-Content (Join-Path $Temporary 'SHA256SUMS') | Where-Object { $_ -match ('^([0-9a-f]{64})  ' + [Regex]::Escape($Archive) + '$') })
    if ($Checksums.Count -ne 1) { throw 'Missing or duplicate release checksum.' }
    $Expected = ($Checksums[0] -split '  ')[0]
    $Actual = (Get-FileHash (Join-Path $Temporary 'archive.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw 'Checksum mismatch; existing installation was preserved.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $Temporary 'archive.zip'))
    try {
        $Entries = @($Zip.Entries | Where-Object { $_.FullName -eq 'tailmouse.exe' })
        if ($Entries.Count -ne 1 -or $Entries[0].Length -lt 1 -or $Entries[0].Length -gt 67108864) { throw 'Invalid release executable.' }
        $Candidate = Join-Path $Temporary 'tailmouse.exe'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($Entries[0], $Candidate, $false)
    } finally { $Zip.Dispose() }
    & $Candidate version
    if ($LASTEXITCODE -ne 0) { throw 'The downloaded executable could not run.' }
    $Destination = Join-Path $InstallDir 'tailmouse.exe'
    if ((Test-Path $Destination) -and ((Get-Item $Destination).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing to replace a link. Use its package manager or another directory.' }
    Move-Item -Force -Path $Candidate -Destination $Destination
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($UserPath -split ';') -notcontains $InstallDir) { [Environment]::SetEnvironmentVariable('Path', ($InstallDir + ';' + $UserPath), 'User') }
    if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path = $InstallDir + ';' + $env:Path }
    Write-Output "Installed TailMouse $Version in $InstallDir. Run tailmouse for guided startup, or tailmouse web 8080. Upgrade with tailmouse update."
} finally { Remove-Item -Recurse -Force -Path $Temporary }
