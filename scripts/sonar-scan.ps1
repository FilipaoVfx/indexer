<#
.SYNOPSIS
    Lanza el analisis de SonarQube sobre este repo usando el scanner dockerizado.

.DESCRIPTION
    Requiere que el servidor SonarQube ya este levantado:
        docker compose -f sonarqube/docker-compose.yml up -d sonarqube

    Y un token generado en http://localhost:9000 (My Account > Security).

.EXAMPLE
    ./scripts/sonar-scan.ps1 -Token squ_xxxxxxxxxxxxxxxx
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Token,

    [string]$HostUrl = "http://sonarqube:9000"
)

$ErrorActionPreference = "Stop"

# Raiz del repo (carpeta padre de /scripts)
$projectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "Analizando $projectRoot contra $HostUrl ..." -ForegroundColor Cyan

docker run --rm `
    --network sonarnet `
    -e SONAR_HOST_URL=$HostUrl `
    -e SONAR_TOKEN=$Token `
    -v "${projectRoot}:/usr/src" `
    sonarsource/sonar-scanner-cli

if ($LASTEXITCODE -eq 0) {
    Write-Host "Analisis completado. Revisa http://localhost:9000" -ForegroundColor Green
} else {
    Write-Host "El scanner termino con codigo $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
