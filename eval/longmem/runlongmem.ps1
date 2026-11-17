<#
.SYNOPSIS
Run LongMemEval preparation, memory indexing, Pi answers and Judge scoring.
.PARAMETER DatasetPath
Dataset JSON file; relative paths are resolved from the caller's working directory.
.PARAMETER OutputDirectory
New output directory. Defaults to runs/<dataset-name>--<next-number> beside this script.
.PARAMETER ResumeDirectory
Existing prepared run whose build was interrupted. Restore its sample list and saved model.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$DatasetPath = (Join-Path $PSScriptRoot '../datasets/LongMemEval/longmemeval_s_cleaned.json'),

    [string]$Provider = 'deepseek',
    [string]$Model = 'deepseek-flash',

    [ValidateRange(1, 2147483647)]
    [int]$Limit = 5,

    [string]$Types,

    [string]$BuildsDirectory,

    [ValidateSet('memory', 'no-memory')]
    [string]$Mode = 'memory',

    [ValidateSet('search', 'vsearch')]
    [string]$Retrieval = 'search',

    [string]$JudgeProvider,
    [string]$JudgeModel,

    [ValidateRange(1, 2147483647)]
    [int]$TimeoutMs = 120000,

    [string]$OutputDirectory,

    [string]$ResumeDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($ResumeDirectory) {
    if ($OutputDirectory -or $BuildsDirectory -or $Types -or $PSBoundParameters.ContainsKey('DatasetPath') -or $PSBoundParameters.ContainsKey('Limit')) {
        throw 'ResumeDirectory uses the existing run manifest; do not pass OutputDirectory, DatasetPath, BuildsDirectory, Types or Limit.'
    }
    $OutputDirectory = (Get-Item -LiteralPath $ResumeDirectory).FullName
    $runManifest = Get-Content -LiteralPath (Join-Path $OutputDirectory 'run-manifest.json') -Raw | ConvertFrom-Json
    if ($runManifest.status -ne 'prepared' -or @($runManifest.sampleDirectories).Count -lt 1) { throw 'A completed run manifest is required.' }
    $savedRetrieval = if ($runManifest.PSObject.Properties['retrieval']) { $runManifest.retrieval } else { 'search' }
    if ($PSBoundParameters.ContainsKey('Retrieval') -and $Retrieval -ne $savedRetrieval) {
        throw 'Retrieval differs from the prepared run manifest.'
    }
    $Retrieval = $savedRetrieval
    $buildManifest = Get-Content -LiteralPath (Join-Path $runManifest.buildDirectory 'build-manifest.json') -Raw | ConvertFrom-Json
    if ($runManifest.buildFingerprint -ne $buildManifest.fingerprint) { throw 'Run manifest points to a different build fingerprint.' }
    $Limit = @($buildManifest.sampleDirectories).Count
    $config = $buildManifest.buildConfig
    if ($config) {
        $separator = $config.model.IndexOf('/')
        if (-not $PSBoundParameters.ContainsKey('Provider')) { $Provider = $config.model.Substring(0, $separator) }
        if (-not $PSBoundParameters.ContainsKey('Model')) { $Model = $config.model.Substring($separator + 1) }
    }
    # This entry resumes an interrupted build. Answer/Judge files remain protected from overwrites.
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory "answer-config-$Mode.json")) {
        throw 'Answer stage already started. Resume build alone with run.ts --stage build --output <directory> --provider <provider> --model <model>.'
    }
    Write-Host "Resume: $OutputDirectory ($Limit questions from manifest)"
} else {
    $datasetFile = Get-Item -LiteralPath $DatasetPath
    if ($datasetFile.PSIsContainer) { throw 'DatasetPath must point to a JSON file.' }
}
if ([string]::IsNullOrWhiteSpace($Provider) -or [string]::IsNullOrWhiteSpace($Model)) {
    throw 'Provider and Model must match your Pi configuration.'
}
$nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source

if ($ResumeDirectory) {
    # The existing output was resolved and validated above; do not create a new experiment.
} elseif ($OutputDirectory) {
    $OutputDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
} else {
    $runsDirectory = Join-Path $PSScriptRoot 'runs'
    New-Item -ItemType Directory -Force -Path $runsDirectory | Out-Null
    $pattern = '^' + [regex]::Escape($datasetFile.BaseName) + '--([0-9]+)$'
    $number = 0L
    # Failed runs also consume a number; never reuse or overwrite their evidence.
    foreach ($directory in Get-ChildItem -LiteralPath $runsDirectory -Directory) {
        if ($directory.Name -match $pattern) {
            $number = [Math]::Max($number, [long]::Parse($Matches[1]))
        }
    }
    $OutputDirectory = Join-Path $runsDirectory ($datasetFile.BaseName + '--' + ($number + 1))
}
if (-not $ResumeDirectory -and (Test-Path -LiteralPath $OutputDirectory)) { throw "Output directory already exists: $OutputDirectory" }

if (-not $ResumeDirectory) { Write-Host "Dataset: $($datasetFile.FullName)" }
Write-Host "Output: $OutputDirectory"
Write-Host "Model: $Provider/$Model; mode: $Mode; retrieval: $Retrieval; questions: up to $Limit"
if ($Types) { Write-Host "Types: $Types" }
Write-Host 'Answer and judge make real model calls.'
if ($Mode -eq 'memory') { Write-Host 'New summary builds call the model once per historical session; cached summaries are reused.' }
if ($Retrieval -eq 'vsearch' -and $Mode -eq 'memory') { Write-Host 'Vector build calls Jina only for missing summary embeddings.' }

$stages = @()
if (-not $ResumeDirectory) { $stages += 'prepare' }
if ($Mode -eq 'memory') { $stages += 'build' }
$stages += @('answer', 'judge')
foreach ($stage in $stages) {
    Write-Host "Stage: $stage"
    $arguments = @(
        (Join-Path $PSScriptRoot 'run.ts'), '--stage', $stage,
        '--output', $OutputDirectory, '--mode', $Mode, '--retrieval', $Retrieval
    )
    if ($stage -eq 'prepare') {
		$arguments += @('--dataset', $datasetFile.FullName, '--limit', "$Limit", '--provider', $Provider, '--model', $Model)
		if ($Types) { $arguments += @('--types', $Types) }
		if ($BuildsDirectory) { $arguments += @('--builds', $BuildsDirectory) }
    } else {
        $arguments += @('--provider', $Provider, '--model', $Model, '--timeout-ms', "$TimeoutMs")
        if ($stage -eq 'judge') {
            if ($JudgeProvider) { $arguments += @('--judge-provider', $JudgeProvider) }
            if ($JudgeModel) { $arguments += @('--judge-model', $JudgeModel) }
        }
    }
    & $nodePath @arguments
    # Windows PowerShell 5.1 does not throw for native command failures.
    if ($LASTEXITCODE -ne 0) {
        throw "$stage failed (exit $LASTEXITCODE); partial results: $OutputDirectory"
    }
}
Write-Host "Report: $(Join-Path $OutputDirectory "metrics-$Mode.json")"
