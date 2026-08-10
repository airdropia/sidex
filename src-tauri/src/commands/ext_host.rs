use crate::commands::extension_platform::{
    build_extension_descriptions, build_init_data, extension_search_paths, global_storage_dir,
    resolve_builtin_extensions_dir, resolve_node_runtime, resolve_server_script, scan_extensions,
    user_extensions_dir, ExtensionHostInitData, ExtensionKind, ExtensionManifest, NodeRuntimeInfo,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Strip the Windows `\\?\` prefix; Node's CJS resolver chokes on UNC paths.
fn normalize_for_node(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        dunce::simplified(&path).to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

struct ExtHostSession {
    child: Child,
    port: u16,
    session_id: String,
    started_at: Instant,
    #[allow(dead_code)]
    init_data: ExtensionHostInitData,
    #[allow(dead_code)]
    manifests: Vec<ExtensionManifest>,
    restart_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPlatformRuntimeState {
    pub running: bool,
    pub port: Option<u16>,
    pub session_id: Option<String>,
    pub uptime_secs: Option<u64>,
    pub restart_count: u32,
    pub total_crashes: u32,
}

/// The extension platform supervisor. Owns the session registry and all
/// lifecycle operations: spawn, stop, restart, crash tracking.
pub struct ExtensionPlatformSupervisor {
    inner: Mutex<SupervisorState>,
}

struct SupervisorState {
    session: Option<ExtHostSession>,
    total_crashes: u32,
}

impl ExtensionPlatformSupervisor {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SupervisorState {
                session: None,
                total_crashes: 0,
            }),
        }
    }

    pub fn ensure_started(
        &self,
        app: &AppHandle,
        _init_data_json: &str,
        _extension_search_paths: &[String],
    ) -> Result<u16, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut session) = guard.session {
            if session.child.try_wait().ok().flatten().is_none() {
                return Ok(session.port);
            }
            guard.total_crashes += 1;
            guard.session = None;
        }
        let started = spawn_host_process(app, &[])?;
        let port = started.port;
        guard.session = Some(ExtHostSession {
            child: started.child,
            port: started.port,
            session_id: started.session_id,
            started_at: Instant::now(),
            init_data: started.init_data,
            manifests: started.manifests,
            restart_count: 1,
        });
        Ok(port)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(mut session) = guard.session.take() {
            let _ = session.child.kill();
            let _ = session.child.wait();
            log::info!("[ext-host] stopped");
        }
        Ok(())
    }

    pub fn restart(
        &self,
        app: &AppHandle,
        init_data_json: &str,
        extension_search_paths: &[String],
    ) -> Result<u16, String> {
        self.stop()?;
        self.ensure_started(app, init_data_json, extension_search_paths)
    }

    pub fn snapshot(&self) -> Result<ExtensionPlatformRuntimeState, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        match &guard.session {
            Some(s) => Ok(ExtensionPlatformRuntimeState {
                running: true,
                port: Some(s.port),
                session_id: Some(s.session_id.clone()),
                uptime_secs: Some(s.started_at.elapsed().as_secs()),
                restart_count: s.restart_count,
                total_crashes: guard.total_crashes,
            }),
            None => Ok(ExtensionPlatformRuntimeState {
                running: false,
                port: None,
                session_id: None,
                uptime_secs: None,
                restart_count: 0,
                total_crashes: guard.total_crashes,
            }),
        }
    }
}

#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionTransportInfo {
    pub kind: String,
    pub endpoint: String,
}

#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPathsInfo {
    pub server_script: String,
    pub builtin_extensions_dir: String,
    pub user_extensions_dir: String,
    pub global_storage_dir: String,
}

#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPlatformBootstrap {
    pub transport: ExtensionTransportInfo,
    pub runtime: NodeRuntimeInfo,
    pub paths: ExtensionPathsInfo,
    pub session_kind: String,
    pub extensions: Vec<ExtensionManifestSummary>,
    pub init_data_json: String,
}

#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPlatformStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub session_id: Option<String>,
    pub uptime_secs: Option<u64>,
    pub extension_count: Option<usize>,
    pub restart_count: Option<u32>,
    pub total_crashes: u32,
}

#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifestSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub activation_events: Vec<String>,
    pub main: Option<String>,
    pub browser: Option<String>,
    pub wasm_binary: Option<String>,
    pub contributes: Vec<String>,
    pub location: String,
}

#[derive(Deserialize)]
struct PortMessage {
    port: u16,
}

struct StartedSession {
    port: u16,
    session_id: String,
    init_data: ExtensionHostInitData,
    manifests: Vec<ExtensionManifest>,
    child: Child,
}

#[allow(clippy::too_many_lines)]
fn spawn_host_process(
    app: &AppHandle,
    workspace_folders: &[String],
) -> Result<StartedSession, String> {
    let runtime = resolve_node_runtime(app)?;
    let server_js = normalize_for_node(resolve_server_script(app));

    if !server_js.exists() {
        return Err(format!(
            "extension host script not found at {}",
            server_js.display()
        ));
    }

    let user_ext_dir = user_extensions_dir();
    let builtin_ext_dir = resolve_builtin_extensions_dir(app);
    let global_store_dir = global_storage_dir();
    let search_paths = extension_search_paths(app);

    let manifests = scan_extensions(app, &search_paths);
    let descriptions = build_extension_descriptions(&manifests);
    let init_data = build_init_data(&descriptions, workspace_folders);
    let session_id = uuid::Uuid::new_v4().to_string();

    log::info!("extensions directory: {}", user_ext_dir.display());
    log::info!(
        "builtin extensions directory: {}",
        builtin_ext_dir.display()
    );
    log::info!("extension runtime: {} ({})", runtime.path, runtime.source);
    log::info!(
        "discovered {} extensions across {} search paths",
        manifests.len(),
        search_paths.len()
    );

    let init_data_json = serde_json::to_string(&init_data)
        .map_err(|e| format!("failed to serialize init data: {e}"))?;

    let search_paths_json = serde_json::to_string(
        &search_paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
    )
    .map_err(|e| format!("failed to encode search paths: {e}"))?;

    let init_data_file = std::env::temp_dir().join(format!("sidex-init-{}.json", &session_id));
    std::fs::write(&init_data_file, &init_data_json)
        .map_err(|e| format!("failed to write init data file: {e}"))?;

    let mut child_cmd = Command::new(&runtime.path);
    child_cmd
        .arg("--max-old-space-size=3072")
        .arg(&server_js)
        .env("SIDEX_EXTENSIONS_DIR", &user_ext_dir)
        .env("SIDEX_BUILTIN_EXTENSIONS_DIR", &builtin_ext_dir)
        .env("SIDEX_GLOBAL_STORAGE_DIR", &global_store_dir)
        .env("SIDEX_EXTENSION_SEARCH_PATHS", &search_paths_json)
        .env("SIDEX_INIT_DATA_FILE", &init_data_file)
        .env("SIDEX_SESSION_ID", &session_id)
        .env("NODE_ENV", "production")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        child_cmd.creation_flags(0x0800_0000);
    }

    let mut child = child_cmd
        .spawn()
        .map_err(|e| format!("failed to spawn extension host: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture extension host stdout")?;

    let stderr_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = Arc::clone(&stderr_buf);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::debug!("[ext-host stderr] {line}");
                if let Ok(mut guard) = buf.lock() {
                    if guard.len() < 200 {
                        guard.push(line);
                    }
                }
            }
        });
    }

    let recent_stderr = || -> String {
        thread::sleep(Duration::from_millis(150));
        match stderr_buf.lock() {
            Ok(guard) if !guard.is_empty() => format!(" stderr: {}", guard.join(" | ")),
            _ => String::new(),
        }
    };

    let port = {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("failed to read extension host port: {e}{}", recent_stderr()))?;
        if bytes_read == 0 {
            let _ = child.kill();
            return Err(format!(
                "extension host exited before sending port message (init_data_file={}).{}",
                init_data_file.display(),
                recent_stderr()
            ));
        }
        let trimmed = line.trim();
        let msg: PortMessage = serde_json::from_str(trimmed).map_err(|e| {
            format!(
                "bad port message: {e} (got {:?}).{}",
                trimmed,
                recent_stderr()
            )
        })?;
        msg.port
    };

    log::info!("extension host started on port {port} (session={session_id})");

    Ok(StartedSession {
        port,
        session_id,
        init_data,
        manifests,
        child,
    })
}

#[allow(dead_code)]
fn build_manifest_summaries(manifests: &[ExtensionManifest]) -> Vec<ExtensionManifestSummary> {
    manifests
        .iter()
        .map(|m| ExtensionManifestSummary {
            id: m.id.clone(),
            name: m.display_name.clone(),
            version: m.version.clone(),
            kind: match m.kind {
                ExtensionKind::Node => "node".to_string(),
                ExtensionKind::Wasm => "wasm".to_string(),
            },
            activation_events: m.activation_events.clone(),
            main: m.main.clone(),
            browser: m.browser.clone(),
            wasm_binary: m.wasm_binary.clone(),
            contributes: m.contributes_keys.clone(),
            location: m.path.clone(),
        })
        .collect()
}

#[allow(dead_code)]
fn ensure_session(guard: &mut SupervisorState, app: &AppHandle) -> Result<(), String> {
    if guard.session.is_some() {
        return Ok(());
    }
    let started = spawn_host_process(app, &[])?;
    guard.session = Some(ExtHostSession {
        child: started.child,
        port: started.port,
        session_id: started.session_id,
        started_at: Instant::now(),
        init_data: started.init_data,
        manifests: started.manifests,
        restart_count: 0,
    });
    Ok(())
}

#[allow(dead_code)]
fn kill_session(session: &mut ExtHostSession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
    log::info!(
        "extension host stopped (session={}, uptime={}s)",
        session.session_id,
        session.started_at.elapsed().as_secs()
    );
}
