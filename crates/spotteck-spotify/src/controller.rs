//! Native Spotify macOS AppleScript controller fallback.
//! When Spotify's backend refuses decryption keys to librespot (audio key error 0 1),
//! Spotteck drives the official Spotify.app in the background via AppleScript,
//! maintaining full playback, playlist navigation, transport controls, and visualizers.

#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Clone, Debug, Default)]
pub struct NativeState {
    pub is_playing: bool,
    pub position_ms: u32,
    pub volume: u8,
    pub shuffling: bool,
    pub track: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u32,
    pub artwork: String,
    pub track_uri: String,
}

#[cfg(target_os = "macos")]
pub fn is_spotify_running() -> bool {
    let script = r#"tell application "System Events" to return (count (every process whose bundle identifier is "com.spotify.client")) > 0"#;
    run_osascript(script).map(|s| s == "true").unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn is_spotify_running() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn ensure_running() {
    if !is_spotify_running() {
        let _ = Command::new("open").args(["-g", "-j", "-a", "/Applications/Spotify.app"]).status();
        std::thread::sleep(std::time::Duration::from_millis(600));
        hide_spotify();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_running() {}

#[cfg(target_os = "macos")]
pub fn spawn_suppression_burst() {
    std::thread::spawn(|| {
        for _ in 0..5 {
            std::thread::sleep(std::time::Duration::from_millis(40));
            hide_spotify();
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_suppression_burst() {}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
struct CGSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGGetActiveDisplayList(max_displays: u32, active_displays: *mut u32, display_count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

/// Returns the bottom-rightmost 1px corner `(x, y)` of the rightmost active display,
/// so the parked Spotify window sits 99.98% in empty space regardless of monitor changes.
#[cfg(target_os = "macos")]
fn parking_spot() -> (i32, i32) {
    let mut displays = [0u32; 16];
    let mut count = 0u32;
    let ok = unsafe { CGGetActiveDisplayList(displays.len() as u32, displays.as_mut_ptr(), &mut count) };
    if ok == 0 && count > 0 {
        let mut best: Option<(i32, i32)> = None;
        for &id in &displays[..(count as usize).min(displays.len())] {
            let b = unsafe { CGDisplayBounds(id) };
            if b.size.width > 0.0 && b.size.height > 0.0 {
                let right_x = (b.origin.x + b.size.width).round() as i32 - 1;
                let bottom_y = (b.origin.y + b.size.height).round() as i32 - 1;
                if best.is_none_or(|(bx, _)| right_x > bx) {
                    best = Some((right_x, bottom_y));
                }
            }
        }
        if let Some(spot) = best {
            return spot;
        }
    }
    (2559, 1079)
}

#[cfg(target_os = "macos")]
pub fn hide_spotify() {
    let (px, py) = parking_spot();
    let script = format!(
        r#"
tell application "System Events"
  if (count (every process whose bundle identifier is "com.spotify.client")) > 0 then
    tell process "Spotify"
      try
        repeat with w in (every window)
          try
            if value of attribute "AXFullScreen" of w is true then
              set value of attribute "AXFullScreen" of w to false
            end if
          end try
          try
            set position of w to {{{px}, {py}}}
            set size of w to {{200, 200}}
          end try
        end repeat
      end try
      try
        set visible to false
      end try
    end tell
  end if
end tell
"#
    );
    let _ = run_osascript(&script);
}

#[cfg(not(target_os = "macos"))]
pub fn hide_spotify() {}

#[cfg(target_os = "macos")]
pub fn play_uri(context_uri: &str, track_uri: Option<&str>) -> Result<(), String> {
    ensure_running();
    let (px, py) = parking_spot();
    let play_cmd = match track_uri {
        Some(track) => format!(r#"play track "{track}" in context "{context_uri}""#),
        None => format!(r#"play track "{context_uri}""#),
    };
    let script = format!(
        r#"
tell application "Spotify" to {play_cmd}
tell application "System Events"
  if (count (every process whose bundle identifier is "com.spotify.client")) > 0 then
    tell process "Spotify"
      try
        repeat with w in (every window)
          try
            if value of attribute "AXFullScreen" of w is true then
              set value of attribute "AXFullScreen" of w to false
            end if
          end try
          try
            set position of w to {{{px}, {py}}}
            set size of w to {{200, 200}}
          end try
        end repeat
      end try
      try
        set visible to false
      end try
    end tell
  end if
end tell
"#
    );
    run_osascript(&script)?;
    spawn_suppression_burst();
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn play_uri(_context_uri: &str, _track_uri: Option<&str>) -> Result<(), String> {
    Err("Native Spotify controller is only supported on macOS.".into())
}

#[cfg(target_os = "macos")]
pub fn play_pause() -> Result<(), String> {
    ensure_running();
    let script = r#"tell application "Spotify" to playpause"#;
    run_osascript(script)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn play_pause() -> Result<(), String> {
    Err("Native Spotify controller is only supported on macOS.".into())
}

#[cfg(target_os = "macos")]
pub fn next() -> Result<(), String> {
    ensure_running();
    let script = r#"tell application "Spotify" to next track"#;
    run_osascript(script)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn next() -> Result<(), String> {
    Err("Native Spotify controller is only supported on macOS.".into())
}

#[cfg(target_os = "macos")]
pub fn prev() -> Result<(), String> {
    ensure_running();
    let script = r#"tell application "Spotify" to previous track"#;
    run_osascript(script)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn prev() -> Result<(), String> {
    Err("Native Spotify controller is only supported on macOS.".into())
}

#[cfg(target_os = "macos")]
pub fn set_volume(percent: u8) -> Result<(), String> {
    let script = format!(r#"tell application "Spotify" to set sound volume to {percent}"#);
    run_osascript(&script)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_volume(_percent: u8) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn set_shuffle(shuffle: bool) -> Result<(), String> {
    let script = format!(r#"tell application "Spotify" to set shuffling to {shuffle}"#);
    run_osascript(&script)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_shuffle(_shuffle: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn seek(seconds: u32) -> Result<(), String> {
    let script = format!(r#"tell application "Spotify" to set player position to {seconds}"#);
    run_osascript(&script)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn seek(_seconds: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn get_state() -> Option<NativeState> {
    const SCRIPT: &str = r#"
tell application "System Events"
  set isRunning to (count (every process whose bundle identifier is "com.spotify.client")) > 0
end tell
if not isRunning then
  return "not_running"
end if
tell application "Spotify"
  set d to character id 0
  set pState to player state as string
  set pPos to (player position * 1000) as integer
  set pVol to sound volume
  set pShuff to shuffling as string
  set curTrack to ""
  set curArtist to ""
  set curAlbum to ""
  set curDuration to 0
  set curArt to ""
  set curId to ""
  try
    set curTrack to name of current track
    set curArtist to artist of current track
    set curAlbum to album of current track
    set curDuration to duration of current track
    set curArt to artwork url of current track
    set curId to id of current track
  end try
  return pState & d & pPos & d & pVol & d & pShuff & d & curTrack & d & curArtist & d & curAlbum & d & curDuration & d & curArt & d & curId
end tell
"#;
    let output = Command::new("osascript").arg("-e").arg(SCRIPT).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let trimmed = s.trim();
    if trimmed == "not_running" || trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('\0').collect();
    if parts.len() < 10 {
        return None;
    }
    Some(NativeState {
        is_playing: parts[0].trim() == "playing",
        position_ms: parts[1].trim().parse().unwrap_or(0),
        volume: parts[2].trim().parse().unwrap_or(100),
        shuffling: parts[3].trim() == "true",
        track: parts[4].trim().to_string(),
        artist: parts[5].trim().to_string(),
        album: parts[6].trim().to_string(),
        duration_ms: parts[7].trim().parse().unwrap_or(0),
        artwork: parts[8].trim().to_string(),
        track_uri: parts[9].trim().to_string(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn get_state() -> Option<NativeState> {
    None
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn parking_spot_reads_active_display_bounds() {
        let (x, y) = parking_spot();
        assert!(x > 0 && y > 0);
    }
}
