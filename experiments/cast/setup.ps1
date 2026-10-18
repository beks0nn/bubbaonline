$ErrorActionPreference = 'Stop'
$castRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$castCache = Join-Path $castRoot '.cache/cast-browser'
$castZip = Join-Path $castCache 'otclient-browser-4.1.zip'
$castRelease = Join-Path $castCache 'release-4.1'
$castHash = 'B1C4F53209794CF5DA8113FE32BB960E0A701605B9DC5DC8485772AB91BBA86E'
New-Item -ItemType Directory -Force -Path $castCache | Out-Null
if (!(Test-Path -LiteralPath $castZip)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/opentibiabr/otclient/releases/download/4.1/otclient-browser.zip' -OutFile $castZip
}
if ((Get-FileHash -LiteralPath $castZip -Algorithm SHA256).Hash -ne $castHash) {
    throw 'Browser archive checksum mismatch. Do not use this download.'
}
if (!(Test-Path -LiteralPath (Join-Path $castRelease 'build-emscripten-web/otclient.wasm'))) {
    Expand-Archive -LiteralPath $castZip -DestinationPath $castRelease
}
Write-Output 'Verified OTClient Redemption 4.1 browser bundle.'
Write-Output 'Next: npm.cmd install --prefix experiments/cast --ignore-scripts'
Write-Output 'Then: npm.cmd start --prefix experiments/cast'
