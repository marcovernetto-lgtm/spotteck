// No console window on release builds for Windows; harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod credentials;
mod now_playing;

use commands::App;
use spotteck_core::pinned::PinnedStore;
use spotteck_core::readiness::Readiness;
use spotteck_core::state::Payload;
use spotteck_spotify::{AudioTap, Engine, EngineConfig};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// A random ID kept per installation, so Spotify Connect lists one stable "Spotteck".
fn device_id(dir: &Path) -> String {
    let path = dir.join("device-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim();
        if !id.is_empty() {
            return id.to_owned();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&path, &id));
    id
}

/// The name the user gave this computer (System Settings → General → About on macOS).
#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
    let output = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output().ok()?;
    String::from_utf8(output.stdout).ok()
}

#[cfg(target_os = "windows")]
fn computer_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn computer_name() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname").or_else(|_| std::fs::read_to_string("/etc/hostname")).ok()
}

fn device_name() -> String {
    computer_name()
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .map(|n| format!("Spotteck · {n}"))
        .unwrap_or_else(|| "Spotteck".into())
}

fn on_state(app: AppHandle) -> impl Fn(Payload) + Send + Sync {
    let last_readiness = Mutex::new(Readiness::SignedOut);
    move |payload: Payload| {
        let _ = app.emit("spotify:state", &payload);
        now_playing::update(&app, &payload);
        let mut last = last_readiness.lock().unwrap();
        if *last != payload.readiness {
            // Signing in or out changes which playlists the grid shows.
            if payload.readiness == Readiness::Ready || *last == Readiness::Ready {
                let _ = app.emit("playlists:changed", ());
            }
            *last = payload.readiness.clone();
        }
    }
}

fn start_analyzer(app: AppHandle, tap: Arc<AudioTap>) {
    let mut status_at: Option<Instant> = None;
    tap.spawn_analyzer(move |frame| {
        let _ = app.emit("audio:frame", &frame);
        if status_at.is_none_or(|at| at.elapsed() > Duration::from_secs(1)) {
            status_at = Some(Instant::now());
            let status = if frame.has_signal() {
                "Visualizzatori: audio reale collegato."
            } else {
                "Visualizzatori: audio collegato, silenzio."
            };
            let _ = app.emit("audio:status", status);
        }
    });
}

/// The renderer interpolates the position itself; a 500ms heartbeat keeps it honest.
fn start_heartbeat(app: AppHandle, engine: Engine) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            tick.tick().await;
            #[cfg(target_os = "macos")]
            if engine.is_native_mode() {
                // osascript blocks: keep it off the async workers.
                let native = engine.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    native.sync_macos_state();
                })
                .await;
            }
            let payload = engine.payload();
            if payload.is_playing {
                let _ = app.emit("spotify:state", &payload);
                now_playing::update(&app, &payload);
            }
        }
    });
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let pinned = PinnedStore::new(data_dir.join("playlists.json"));
            if let Ok(support) = app.path().data_dir() {
                // Playlists pinned in Spotteck 1.x (Electron).
                pinned.import_legacy(&support.join("Spotteck/user-data/playlists.json"));
            }

            let tap = Arc::new(AudioTap::default());
            let engine = Engine::new(EngineConfig {
                device_name: device_name(),
                device_id: device_id(&data_dir),
                tmp_dir: app.path().temp_dir()?,
                credentials: Arc::new(credentials::Keychain),
                on_state: Box::new(on_state(handle.clone())),
                tap: tap.clone(),
            });

            now_playing::install(app, engine.clone());
            start_analyzer(handle.clone(), tap);
            start_heartbeat(handle.clone(), engine.clone());
            let starting = engine.clone();
            tauri::async_runtime::spawn(async move { starting.start() });

            #[cfg(target_os = "macos")]
            std::thread::spawn(spotteck_spotify::hide_spotify);

            app.manage(App { engine, pinned });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::play_pause,
            commands::next,
            commands::prev,
            commands::set_shuffle,
            commands::seek,
            commands::set_volume,
            commands::play_uri,
            commands::play_track_in_context,
            commands::get_profile,
            commands::login,
            commands::logout,
            commands::playlists_get,
            commands::playlists_tracks,
            commands::playlists_add_url,
            commands::playlists_remove,
        ])
        .build(tauri::generate_context!())
        .expect("Spotteck failed to start");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<App>() {
                state.engine.disconnect();
            }
        }
    });
}
