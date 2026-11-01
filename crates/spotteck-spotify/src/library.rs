//! The user's playlists and their tracks, read through the librespot session.

use futures_util::stream::{self, StreamExt};
use librespot_core::{Session, SpotifyId, SpotifyUri};
use librespot_metadata::{Metadata, Playlist, Track};
use protobuf::Message;
use spotteck_core::library::{PlaylistEntry, TrackEntry};
use spotteck_core::uri::{playlist_id_of, playlist_uri};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LIST_TTL: Duration = Duration::from_secs(5 * 60);
const TRACKS_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_TRACKS: usize = 500;
const PARALLEL: usize = 8;

#[derive(Default)]
pub(crate) struct Library {
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    list: Option<(Instant, Vec<PlaylistEntry>)>,
    summaries: HashMap<String, (Instant, PlaylistEntry)>,
    tracks: HashMap<String, (Instant, Vec<TrackEntry>)>,
}

fn fresh<T: Clone>(entry: Option<&(Instant, T)>, ttl: Duration) -> Option<T> {
    entry.filter(|(at, _)| at.elapsed() < ttl).map(|(_, value)| value.clone())
}

fn playlist_spotify_uri(id: &str) -> Result<SpotifyUri, String> {
    let id = playlist_id_of(id).ok_or("Playlist non valida.")?;
    let id = SpotifyId::from_base62(&id).map_err(|_| "Playlist non valida.")?;
    Ok(SpotifyUri::Playlist { id, user: None })
}

fn image_url(session: &Session, file_id: &str) -> String {
    session
        .get_user_attribute("image-url")
        .unwrap_or_else(|| "https://i.scdn.co/image/{file_id}".into())
        .replace("{file_id}", file_id)
}

/// The album cover closest to 300 px wide, which fits a tile and the artwork backdrop.
pub(crate) fn pick_cover<'a>(covers: impl Iterator<Item = (&'a str, i32)>) -> Option<String> {
    covers.min_by_key(|(_, width)| (width - 300).abs()).map(|(url, _)| url.to_owned())
}

fn album_cover(session: &Session, track: &Track) -> String {
    let urls: Vec<(String, i32)> =
        track.album.covers.iter().map(|c| (image_url(session, &c.id.to_string()), c.width)).collect();
    pick_cover(urls.iter().map(|(u, w)| (u.as_str(), *w))).unwrap_or_default()
}

fn playlist_picture(session: &Session, playlist: &Playlist) -> Option<String> {
    let attributes = &playlist.attributes;
    for target in ["default", "large", "small"] {
        if let Some(size) = attributes.picture_sizes.iter().find(|s| s.target_name == target && !s.url.is_empty()) {
            return Some(size.url.clone());
        }
    }
    if let Some(size) = attributes.picture_sizes.iter().find(|s| !s.url.is_empty()) {
        return Some(size.url.clone());
    }
    (!attributes.picture.is_empty())
        .then(|| image_url(session, &librespot_core::FileId::from_raw(&attributes.picture).to_string()))
}

fn track_entry(track: &Track) -> Option<TrackEntry> {
    Some(TrackEntry {
        uri: track.id.to_uri().ok()?,
        title: if track.name.is_empty() { "Brano".into() } else { track.name.clone() },
        artist: track.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "),
        duration: u32::try_from(track.duration.max(0)).unwrap_or(0) / 1000,
        playable: track.duration > 0,
    })
}

impl Library {
    pub(crate) fn clear(&self) {
        *self.cache.lock().unwrap() = Cache::default();
    }

    /// The playlists in the user's library (their own and the ones they follow), in Spotify's order.
    pub(crate) async fn playlists(&self, session: &Session) -> Result<Vec<PlaylistEntry>, String> {
        if let Some(list) = fresh(self.cache.lock().unwrap().list.as_ref(), LIST_TTL) {
            return Ok(list);
        }
        let bytes = session
            .spclient()
            .get_rootlist(0, Some(500))
            .await
            .map_err(|_| "Impossibile caricare la libreria Spotify.".to_owned())?;
        let rootlist = librespot_protocol::playlist4_external::SelectedListContent::parse_from_bytes(&bytes)
            .map_err(|_| "Risposta inattesa dalla libreria Spotify.".to_owned())?;
        // Folders appear as start-group/end-group markers; only playlists are kept.
        let ids: Vec<String> = rootlist.contents.items.iter().filter_map(|item| playlist_id_of(item.uri())).collect();
        let list: Vec<PlaylistEntry> = stream::iter(ids)
            .map(|id| async move { self.summary(session, &id).await.ok() })
            .buffered(PARALLEL)
            .filter_map(|entry| async move { entry })
            .collect()
            .await;
        self.cache.lock().unwrap().list = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    /// Name and cover of one playlist. Playlists without their own picture use the
    /// cover of their first track, as Spotify's mosaic does.
    pub(crate) async fn summary(&self, session: &Session, id: &str) -> Result<PlaylistEntry, String> {
        let uri = playlist_spotify_uri(id)?;
        let key = playlist_id_of(id).unwrap_or_default();
        if let Some(entry) = fresh(self.cache.lock().unwrap().summaries.get(&key), LIST_TTL) {
            return Ok(entry);
        }
        let playlist = Playlist::get(session, &uri)
            .await
            .map_err(|_| "Playlist Spotify non trovata o non accessibile.".to_owned())?;
        let mut image = playlist_picture(session, &playlist);
        if image.is_none() {
            if let Some(first) = playlist.tracks().find(|t| matches!(t, SpotifyUri::Track { .. })) {
                if let Ok(track) = Track::get(session, first).await {
                    image = Some(album_cover(session, &track)).filter(|s| !s.is_empty());
                }
            }
        }
        let entry = PlaylistEntry {
            id: playlist_uri(&key),
            name: if playlist.name().is_empty() { "Playlist".into() } else { playlist.name().to_owned() },
            image: image.unwrap_or_default(),
            pinned: false,
        };
        self.cache.lock().unwrap().summaries.insert(key, (Instant::now(), entry.clone()));
        Ok(entry)
    }

    /// The first [`MAX_TRACKS`] tracks of a playlist, in order. Podcast episodes and local
    /// files are left out.
    pub(crate) async fn tracks(&self, session: &Session, id: &str) -> Result<Vec<TrackEntry>, String> {
        let uri = playlist_spotify_uri(id)?;
        let key = playlist_id_of(id).unwrap_or_default();
        if let Some(tracks) = fresh(self.cache.lock().unwrap().tracks.get(&key), TRACKS_TTL) {
            return Ok(tracks);
        }
        let playlist = Playlist::get(session, &uri)
            .await
            .map_err(|_| "Impossibile caricare i brani della playlist.".to_owned())?;
        let uris: Vec<SpotifyUri> =
            playlist.tracks().filter(|t| matches!(t, SpotifyUri::Track { .. })).take(MAX_TRACKS).cloned().collect();
        let tracks: Vec<TrackEntry> = stream::iter(uris)
            .map(|uri| async move { Track::get(session, &uri).await.ok().as_ref().and_then(track_entry) })
            .buffered(PARALLEL * 2)
            .filter_map(|entry| async move { entry })
            .collect()
            .await;
        self.cache.lock().unwrap().tracks.insert(key, (Instant::now(), tracks.clone()));
        Ok(tracks)
    }

    /// Resolves the starting track URI of a playlist (first track, or a pseudo-random one
    /// when `shuffle` is active) so `Spotify.app` can be given `play track X in context Y`
    /// directly without triggering its ~0.5s context-resume restart.
    pub(crate) async fn entry_track(&self, session: &Session, id: &str, shuffle: bool) -> Option<String> {
        let uri = playlist_spotify_uri(id).ok()?;
        let key = playlist_id_of(id)?;
        if let Some(tracks) = fresh(self.cache.lock().unwrap().tracks.get(&key), TRACKS_TTL) {
            let playable: Vec<&TrackEntry> = tracks.iter().filter(|t| t.playable).collect();
            if !playable.is_empty() {
                let idx = if shuffle {
                    let nanos = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.subsec_nanos() as usize)
                        .unwrap_or(0);
                    nanos % playable.len()
                } else {
                    0
                };
                return Some(playable[idx].uri.clone());
            }
        }
        let playlist = Playlist::get(session, &uri).await.ok()?;
        let uris: Vec<SpotifyUri> =
            playlist.tracks().filter(|t| matches!(t, SpotifyUri::Track { .. })).take(MAX_TRACKS).cloned().collect();
        if uris.is_empty() {
            return None;
        }
        let idx = if shuffle {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as usize)
                .unwrap_or(0);
            nanos % uris.len()
        } else {
            0
        };
        uris[idx].to_uri().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_cover_nearest_300px() {
        let covers = [("small", 64), ("medium", 300), ("large", 640)];
        assert_eq!(pick_cover(covers.iter().copied()).as_deref(), Some("medium"));
        assert_eq!(pick_cover([("only", 640)].into_iter()).as_deref(), Some("only"));
        assert_eq!(pick_cover(std::iter::empty()), None);
    }

    #[test]
    fn rejects_non_playlists() {
        assert!(playlist_spotify_uri("spotify:album:37i9dQZF1DXcBWIGoYBM5M").is_err());
        assert!(playlist_spotify_uri("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M").is_ok());
    }
}
