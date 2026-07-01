//! Best-effort external cleanup for loopback Ollama resources.
//!
//! Graceful shutdown unloads models in-process. A hard Windows termination
//! (`TerminateProcess`, Task Manager, dev-script stale kill) cannot run Rust
//! cleanup, so this module stages a tiny detached PowerShell watcher that waits
//! for the current WinSTT PID to disappear and then evicts only the loopback
//! Ollama models WinSTT recorded during this run.

#[cfg(windows)]
mod platform {
    use std::collections::{BTreeMap, BTreeSet};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    use serde::Serialize;

    #[derive(Default)]
    struct WatchdogState {
        endpoints: BTreeMap<String, BTreeSet<String>>,
        spawned_ollama_pid: Option<u32>,
    }

    #[derive(Serialize)]
    struct WatchdogFile {
        endpoints: Vec<WatchdogEndpoint>,
        #[serde(skip_serializing_if = "Option::is_none")]
        spawned_ollama_pid: Option<u32>,
    }

    #[derive(Serialize)]
    struct WatchdogEndpoint {
        endpoint: String,
        models: Vec<String>,
    }

    static STATE: OnceLock<Mutex<WatchdogState>> = OnceLock::new();
    static STATE_PATH: OnceLock<PathBuf> = OnceLock::new();
    static SCRIPT_PATH: OnceLock<PathBuf> = OnceLock::new();

    pub fn install() {
        if let Err(err) = install_impl() {
            log::warn!("[model-watchdog] failed to install Ollama cleanup watchdog: {err}");
        }
    }

    pub fn track_ollama_model(endpoint: &str, model: &str) {
        let model = model.trim();
        if model.is_empty() {
            return;
        }
        let Some(endpoint) = normalize_loopback_endpoint(endpoint) else {
            return;
        };
        with_state(|state| {
            state
                .endpoints
                .entry(endpoint)
                .or_default()
                .insert(model.to_string());
        });
    }

    pub fn untrack_ollama_model(endpoint: &str, model: &str) {
        let model = model.trim();
        if model.is_empty() {
            return;
        }
        let Some(endpoint) = normalize_loopback_endpoint(endpoint) else {
            return;
        };
        with_state(|state| {
            if let Some(models) = state.endpoints.get_mut(&endpoint) {
                models.remove(model);
                if models.is_empty() {
                    state.endpoints.remove(&endpoint);
                }
            }
        });
    }

    pub fn track_spawned_ollama_pid(pid: u32) {
        if pid == 0 {
            return;
        }
        with_state(|state| {
            state.spawned_ollama_pid = Some(pid);
        });
    }

    pub fn clear_spawned_ollama_pid() {
        with_state(|state| {
            state.spawned_ollama_pid = None;
        });
    }

    fn install_impl() -> io::Result<()> {
        let pid = std::process::id();
        let temp_dir = std::env::temp_dir();
        let state_path = temp_dir.join(format!("winstt-model-watchdog-{pid}.json"));
        let script_path = temp_dir.join(format!("winstt-model-watchdog-{pid}.ps1"));

        let _ = STATE_PATH.set(state_path.clone());
        let _ = SCRIPT_PATH.set(script_path.clone());
        STATE.get_or_init(|| Mutex::new(WatchdogState::default()));
        with_state(|_| {});

        std::fs::write(
            &script_path,
            watchdog_script(pid, &state_path, &script_path),
        )?;

        let watchdog_pid = spawn_watchdog_process(&script_path)?;

        log::info!(
            "[model-watchdog] installed hard-exit Ollama cleanup watcher pid {watchdog_pid} for WinSTT pid {pid}"
        );
        Ok(())
    }

    fn spawn_watchdog_process(script_path: &Path) -> io::Result<u32> {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

        let exe = powershell_exe();
        let script_arg = script_path.to_string_lossy().into_owned();
        let attempts = [
            (
                "hidden-new-group",
                CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
            ),
            (
                "hidden-breakaway",
                CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
            ),
            ("hidden", CREATE_NO_WINDOW),
        ];

        let mut last_error = None;
        for (label, flags) in attempts {
            match spawn_watchdog_with_flags(&exe, &script_arg, flags) {
                Ok(pid) => {
                    log::info!("[model-watchdog] spawned watcher with {label} flags (pid {pid})");
                    return Ok(pid);
                }
                Err(err) => {
                    log::warn!("[model-watchdog] watcher spawn attempt {label} failed: {err}");
                    last_error = Some(err);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| io::Error::other("no spawn attempts ran")))
    }

    fn spawn_watchdog_with_flags(exe: &Path, script_arg: &str, flags: u32) -> io::Result<u32> {
        use std::os::windows::process::CommandExt;

        let mut child = std::process::Command::new(exe)
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script_arg,
            ])
            .creation_flags(flags)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;

        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "watchdog exited immediately with {status}"
            )));
        }
        Ok(child.id())
    }

    fn powershell_exe() -> PathBuf {
        let system_root = std::env::var_os("SystemRoot")
            .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
        let candidate = system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            candidate
        } else {
            PathBuf::from("powershell.exe")
        }
    }

    fn with_state(update: impl FnOnce(&mut WatchdogState)) {
        let Some(path) = STATE_PATH.get() else {
            return;
        };
        let state = STATE.get_or_init(|| Mutex::new(WatchdogState::default()));
        let Ok(mut guard) = state.lock() else {
            log::warn!("[model-watchdog] state lock poisoned; skipping update");
            return;
        };
        update(&mut guard);
        if let Err(err) = persist_state(path, &guard) {
            log::warn!("[model-watchdog] failed to persist cleanup state: {err}");
        }
    }

    fn persist_state(path: &Path, state: &WatchdogState) -> io::Result<()> {
        let payload = WatchdogFile {
            endpoints: state
                .endpoints
                .iter()
                .map(|(endpoint, models)| WatchdogEndpoint {
                    endpoint: endpoint.clone(),
                    models: models.iter().cloned().collect(),
                })
                .collect(),
            spawned_ollama_pid: state.spawned_ollama_pid,
        };
        let text = serde_json::to_string_pretty(&payload)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        std::fs::write(path, text)
    }

    fn normalize_loopback_endpoint(endpoint: &str) -> Option<String> {
        let trimmed = endpoint.trim().trim_end_matches('/');
        let url = reqwest::Url::parse(trimmed).ok()?;
        if url.scheme() != "http" {
            return None;
        }
        let host = url
            .host_str()?
            .trim_matches(&['[', ']'][..])
            .to_ascii_lowercase();
        if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
            Some(trimmed.to_string())
        } else {
            None
        }
    }

    fn watchdog_script(parent_pid: u32, state_path: &Path, script_path: &Path) -> String {
        format!(
            r#"$ErrorActionPreference = 'SilentlyContinue'
$parentPid = {parent_pid}
$statePath = '{state_path}'
$scriptPath = '{script_path}'

while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {{
  Start-Sleep -Milliseconds 750
}}

Start-Sleep -Milliseconds 400

function Read-WinSTTState {{
  if (!(Test-Path -LiteralPath $statePath)) {{ return $null }}
  try {{
    return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  }} catch {{
    return $null
  }}
}}

$state = Read-WinSTTState
if ($state -ne $null -and $state.endpoints -ne $null) {{
  foreach ($entry in @($state.endpoints)) {{
    $endpoint = [string]$entry.endpoint
    if ([string]::IsNullOrWhiteSpace($endpoint)) {{ continue }}
    $endpoint = $endpoint.TrimEnd('/')
    foreach ($model in @($entry.models)) {{
      if ([string]::IsNullOrWhiteSpace([string]$model)) {{ continue }}
      try {{
        $body = @{{ model = [string]$model; prompt = ""; stream = $false; keep_alive = 0 }} | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri ($endpoint + '/api/generate') -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
      }} catch {{}}
    }}
  }}
}}

if ($state -ne $null -and $state.spawned_ollama_pid -ne $null) {{
  try {{
    $ollamaPid = [int]$state.spawned_ollama_pid
    if ($ollamaPid -gt 0) {{
      & taskkill.exe /PID $ollamaPid /T /F | Out-Null
    }}
  }} catch {{}}
}}

Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
"#,
            parent_pid = parent_pid,
            state_path = ps_single_quote(state_path),
            script_path = ps_single_quote(script_path)
        )
    }

    fn ps_single_quote(path: &Path) -> String {
        path.to_string_lossy().replace('\'', "''")
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn install() {}
    pub fn track_ollama_model(_endpoint: &str, _model: &str) {}
    pub fn untrack_ollama_model(_endpoint: &str, _model: &str) {}
    pub fn track_spawned_ollama_pid(_pid: u32) {}
    pub fn clear_spawned_ollama_pid() {}
}

pub use platform::*;
