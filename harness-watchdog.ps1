# harness-watchdog.ps1
# Harness 4-에이전트 자동 워치독 + SR 자율 순찰 보장
#
# 동작:
#   - worker/verifier/strategic 세션 중 하나라도 존재 → Supervisor에 워치독 트리거 전송 (3분마다)
#   - strategic 세션 존재 → SR에 순찰 nudge 전송 (5분마다)
#
# 실행:
#   Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File harness-watchdog.ps1" -WindowStyle Hidden
#
# 종료: psmux kill-session -t worker 등으로 모든 harness 세션 종료 시 자동 루프 탈출

param(
    [string]$SupervisorSession = "vaultvoice",
    [int]$WatchdogIntervalSec = 180,   # 3분
    [int]$SrPatrolIntervalSec = 300    # 5분
)

function Get-Timestamp { Get-Date -Format "HH:mm:ss" }

function Session-Exists($name) {
    $result = psmux ls -F "#{session_name}" 2>$null | Select-String -Pattern "^${name}$" -Quiet
    return [bool]$result
}

$lastSrNudge = [DateTime]::MinValue
$cycleCount = 0

Write-Host "[harness-watchdog] 시작. Supervisor=$SupervisorSession, 워치독=${WatchdogIntervalSec}s, SR순찰=${SrPatrolIntervalSec}s"

while ($true) {
    $cycleCount++
    $ts = Get-Timestamp
    $hasWorker    = Session-Exists "worker"
    $hasVerifier  = Session-Exists "verifier"
    $hasStrategic = Session-Exists "strategic"
    $hasAnyAgent  = $hasWorker -or $hasVerifier -or $hasStrategic

    if (-not $hasAnyAgent) {
        Write-Host "[$ts] harness 세션 없음 — 대기 중 (${WatchdogIntervalSec}s)"
        Start-Sleep -Seconds $WatchdogIntervalSec
        continue
    }

    # ── Supervisor 워치독 트리거 ──────────────────────────────────────────
    if (Session-Exists $SupervisorSession) {
        $msg = "🔍 자동 워치독 #${cycleCount} (${ts}) — worker:$([int]$hasWorker) verifier:$([int]$hasVerifier) strategic:$([int]$hasStrategic)"
        psmux send-keys -t $SupervisorSession $msg
        Start-Sleep -Seconds 1
        psmux send-keys -t $SupervisorSession Enter
        Write-Host "[$ts] Supervisor 워치독 전송: $msg"

        # harness.watchdog-guard 자동 갱신 — 자동 워치독이 켜져 있으면 타임스탬프 자동 업데이트
        $tsFile = Join-Path $PSScriptRoot ".last-watchdog-ts"
        [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Set-Content $tsFile
        Write-Host "[$ts] .last-watchdog-ts 갱신"
    }

    # ── SR 순찰 nudge (5분 간격) ─────────────────────────────────────────
    if ($hasStrategic) {
        $elapsed = ([DateTime]::Now - $lastSrNudge).TotalSeconds
        if ($elapsed -ge $SrPatrolIntervalSec) {
            psmux send-keys -t strategic "⏰ 5분 경과. 순찰 실행해라: execution-log.md Read → 이슈 점검 → 기록."
            Start-Sleep -Seconds 1
            psmux send-keys -t strategic Enter
            $lastSrNudge = [DateTime]::Now
            Write-Host "[$ts] SR 순찰 nudge 전송"
        }
    }

    Start-Sleep -Seconds $WatchdogIntervalSec
}
