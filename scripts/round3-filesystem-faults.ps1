$ErrorActionPreference='Stop'
$taskNode=(Resolve-Path '_verify/node-runtime/node_modules/node/bin/node.exe').Path
$targetOutput=& $taskNode --import tsx scripts/round3-filesystem-probe.mts init
if($LASTEXITCODE -ne 0){throw 'Fixture initialization failed'}
$target=[System.IO.Path]::GetFullPath(($targetOutput | Select-Object -Last 1))
$expectedRoot=[System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path '_verify/filesystem-faults/raw'))+[System.IO.Path]::DirectorySeparatorChar
if(-not $target.StartsWith($expectedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture path escaped the private scratch directory'}
$savedAcl=(Get-Acl -LiteralPath $target).Sddl
try {
  $restrictedAcl=Get-Acl -LiteralPath $target
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $deny=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Deny)
  $restrictedAcl.AddAccessRule($deny)
  Set-Acl -LiteralPath $target -AclObject $restrictedAcl
  & $taskNode --import tsx scripts/round3-filesystem-probe.mts denied
  if($LASTEXITCODE -ne 0){throw 'ACL denial verification failed'}
} finally {
  $restoredAcl=[System.Security.AccessControl.FileSecurity]::new()
  $restoredAcl.SetSecurityDescriptorSddlForm($savedAcl)
  Set-Acl -LiteralPath $target -AclObject $restoredAcl
}
$exclusive=[System.IO.File]::Open($target,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
try { & $taskNode --import tsx scripts/round3-filesystem-probe.mts denied; if($LASTEXITCODE -ne 0){throw 'Exclusive handle denial verification failed'} }
finally { $exclusive.Dispose() }
& $taskNode --import tsx scripts/round3-filesystem-probe.mts verify
if($LASTEXITCODE -ne 0){throw 'Original verification after fault recovery failed'}
Write-Output 'PASS: private-file ACL restored, exclusive handle closed, original bytes unchanged'
