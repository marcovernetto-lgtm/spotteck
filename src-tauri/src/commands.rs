//! The commands behind `window.spotteck` (ui/bridge.js). Return shapes match what app.js
//! already reads: `{ ok }` / `{ error }` for controls, `{ success, … }` for playlists.

use serde_json::{json, Value};
use spotteck_core::library::{merge, PlaylistEntry};
use spotteck_core::pinned::{PinnedPlaylist, PinnedStore};
use spotteck_core::state::Payload;
use spotteck_core::uri::playlist_id_of;
use spotteck_spotify::Engine;
use tauri::State;

pub struct App {
    pub engine: Engine,
    pub pinned: PinnedStore,
}

fn reply(result: Result<(), String>) -> Value {
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    }
}

#[tauri::command]
pub fn get_state(app: State<'_, App>) -> Payload {
    app.engine.payload()
}

#[tauri::command]
pub fn play_pause(app: State<'_, App>) -> Value {
    reply(app.engine.play_pause())
}

#[tauri::command]
pub fn next(app: State<'_, App>) -> Value {
    reply(app.engine.next())
}

#[tauri::command]
pub fn prev(app: State<'_, App>) -> Value {
    reply(app.engine.prev())
}

#[tauri::command]
pub fn set_shuffle(app: State<'_, App>, value: bool) -> Value {
    reply(app.engine.set_shuffle(value))
}

#[tauri::command]
pub fn seek(app: State<'_, App>, seconds: f64) -> Value {
    reply(app.engine.seek(seconds))
}

#[tauri::command]
pub fn set_volume(app: State<'_, App>, volume: f64) -> Value {
    reply(app.engine.set_volume(volume))
}

#[tauri::command]
pub async fn play_uri(app: State<'_, App>, uri: String) -> Result<Value, ()> {
    Ok(reply(app.engine.play(&uri, None).await))
}

#[tauri::command]
pub async fn play_track_in_context(app: State<'_, App>, track: String, context: String) -> Result<Value, ()> {
    Ok(reply(app.engine.play(&context, Some(&track)).await))
}

#[tauri::command]
pub async fn get_profile(app: State<'_, App>) -> Result<Value, ()> {
    let readiness = app.engine.readiness();
    let profile = app.engine.profile().await;
    Ok(json!({
        "authenticated": profile.is_some(),
        "readiness": readiness,
        "message": readiness.message(),
        "profile": profile,
    }))
}

#[tauri::command]
pub async fn login(app: State<'_, App>) -> Result<Value, ()> {
    Ok(reply(app.engine.login().await))
}

#[tauri::command]
pub fn logout(app: State<'_, App>) -> Value {
    app.engine.logout();
    json!({ "ok": true })
}

/// Library plus pinned playlists. Signed out or offline, only the pinned ones.
async fn all_playlists(app: &App, pinned: &[PinnedPlaylist]) -> Vec<PlaylistEntry> {
    let library = match app.engine.playlists().await {
        Ok(list) => list,
        Err(e) => {
            log::info!("Library not loaded: {e}");
            Vec::new()
        }
    };
    merge(library, pinned)
}

#[tauri::command]
pub async fn playlists_get(app: State<'_, App>) -> Result<Vec<PlaylistEntry>, String> {
    let pinned = app.pinned.load().map_err(|e| e.to_string())?;
    Ok(all_playlists(&app, &pinned).await)
}

#[tauri::command]
pub async fn playlists_tracks(app: State<'_, App>, id: String) -> Result<Value, ()> {
    Ok(match app.engine.tracks(&id).await {
        Ok(tracks) if tracks.is_empty() => json!({ "success": false, "error": "Nessun brano trovato." }),
        Ok(tracks) => json!({ "success": true, "tracks": tracks }),
        Err(error) => json!({ "success": false, "error": error }),
    })
}

#[tauri::command]
pub async fn playlists_add_url(app: State<'_, App>, url: String) -> Result<Value, ()> {
    if playlist_id_of(&url).is_none() {
        return Ok(json!({ "success": false, "error": "Link playlist Spotify non valido." }));
    }
    let entry = match app.engine.playlist(&url).await {
        Ok(entry) => entry,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let pinned = PinnedPlaylist {
        id: playlist_id_of(&entry.id).unwrap_or_default(),
        name: entry.name.clone(),
        image: entry.image.clone(),
    };
    Ok(match app.pinned.upsert(pinned) {
        Ok(list) => json!({ "success": true, "playlist": entry, "all": all_playlists(&app, &list).await }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    })
}

#[tauri::command]
pub async fn playlists_remove(app: State<'_, App>, id: String) -> Result<Vec<PlaylistEntry>, String> {
    let list = app.pinned.remove(&id).map_err(|e| e.to_string())?;
    Ok(all_playlists(&app, &list).await)
}
