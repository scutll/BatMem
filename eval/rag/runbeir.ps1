<#
.SYNOPSIS
Run BEIR retrieval and scoring with a fresh, automatically numbered output directory.
.PARAMETER DatasetPath
Directory containing corpus.jsonl, queries.jsonl and qrels/<Split>.tsv; relative to the caller.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$DatasetPath,

    [Parameter(Position = 1)]
    [ValidateRange(1, 2147483647)]
    [int]$TopK = 10,

    [Parameter(Position = 2)]
    [ValidatePattern('^[a-zA-Z0-9_-]+$')]
    [string]$Split = 'test',

    [ValidateNotNullOrEmpty()]
    [string]$Mode = 'search',

    [string]$BuildsDirectory = (Join-Path $PSScriptRoot 'builds')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$datasetDirectory = Get-Item -LiteralPath $DatasetPath
if (-not $datasetDirectory.PSIsContainer) {
    throw 'DatasetPath must point to a directory.'
}
foreach ($relativePath in @('corpus.jsonl', 'queries.jsonl', "qrels/$Split.tsv")) {
    $sourceFile = Join-Path $datasetDirectory.FullName $relativePath
    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "Missing dataset file: $sourceFile"
    }
}

$pythonPath = Join-Path $PSScriptRoot '../.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw 'Create eval/.venv with python -m venv, then install eval/rag/requirements.txt using its Python.'
}
$nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
# Native command failures do not throw automatically in Windows PowerShell 5.1.
& $pythonPath -c "from importlib.metadata import version; version('ragas')"
if ($LASTEXITCODE -ne 0) { throw 'Install eval/rag/requirements.txt before running evaluation.' }

$runsDirectory = Join-Path $PSScriptRoot 'runs'
New-Item -ItemType Directory -Force -Path $runsDirectory | Out-Null
$pattern = '^' + [regex]::Escape($datasetDirectory.Name) + '--([0-9]+)$'
$number = 0L
# Take the maximum suffix so gaps and failed experiments keep their existing numbers.
foreach ($directory in Get-ChildItem -LiteralPath $runsDirectory -Directory) {
    if ($directory.Name -match $pattern) {
        $number = [Math]::Max($number, [long]::Parse($Matches[1]))
    }
}
$outputDirectory = Join-Path $runsDirectory ($datasetDirectory.Name + '--' + ($number + 1))
Write-Host "Dataset: $($datasetDirectory.FullName)"
Write-Host "Output: $outputDirectory"
Write-Host "Mode: $Mode; Top-K: $TopK"
Write-Host "Reusable indexes: $BuildsDirectory"

# The runner creates output exclusively, protecting existing results even if two invocations race.
& $nodePath (Join-Path $PSScriptRoot 'run.ts') --dataset $datasetDirectory.FullName --output $outputDirectory --top-k $TopK --split $Split --mode $Mode --builds $BuildsDirectory
if ($LASTEXITCODE -ne 0) { throw "Retrieval failed (exit $LASTEXITCODE); partial results: $outputDirectory" }

$cutoffs = @(1)
Write-Host 'Stage: scoring retrieval results'
if ($TopK -ge 5) { $cutoffs += 5 }
if ($TopK -ne 1 -and $TopK -ne 5) { $cutoffs += $TopK }
& $pythonPath (Join-Path $PSScriptRoot 'score_rag.py') $outputDirectory --k @cutoffs
if ($LASTEXITCODE -ne 0) { throw "Scoring failed (exit $LASTEXITCODE); retrieval results: $outputDirectory" }
Write-Host "Report: $(Join-Path $outputDirectory 'metrics.json')"
