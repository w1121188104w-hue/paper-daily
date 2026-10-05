$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $env:LOCALAPPDATA 'PaperDailyWorkflow/python'
$executable=Join-Path $runtime 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $executable)) {
  $pythonCommand=Get-Command python -ErrorAction Stop
  & $pythonCommand.Source -m venv $runtime
  if ($LASTEXITCODE -ne 0) { throw 'PYTHON_ENVIRONMENT_FAILED' }
}
& $executable -m pip install --disable-pip-version-check -r (Join-Path $project 'tools/local-collector/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_DEPENDENCIES_FAILED' }
& $executable (Join-Path $project 'tools/local-collector/setup_models.py')
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_CAPTCHA_MODEL_FAILED' }
Write-Host '本地 Python 环境已准备好。重启本机服务后，可在插件里启动补采。'
