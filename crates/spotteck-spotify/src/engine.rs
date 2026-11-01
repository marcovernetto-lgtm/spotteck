//! One librespot session that logs in, plays as the "Spotteck" Spotify Connect device and
//! reports player state. Every async path captures the account generation and drops its
//! result if the user logged out or switched account meanwhile.

use crate::library::{pick_cover, Library};
use crate::tap::{AudioTap, TeeSink};
use librespot_connect::{
    ConnectConfig, LoadContextOptions, LoadRequest, LoadRequestOptions, Options, PlayingTrack, Spirc,
};
use librespot_core::authentication::Credentials;
use librespot_core::config::DeviceType;
use librespot_core::{Error, Session, SessionConfig};
use librespot_metadata::audio::{AudioItem, UniqueFields};
use librespot_oauth::OAuthClientBuilder;
use librespot_playback::audio_backend;
use librespot_playback::config::{AudioFormat, Bitrate, PlayerConfig};
use librespot_playback::mixer::softmixer::SoftMixer;
use librespot_playback::mixer::{Mixer, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent, PlayerEventChannel};
use librespot_protocol::authentication::AuthenticationType;
use serde::Serialize;
use spotteck_core::library::{PlaylistEntry, TrackEntry};
use spotteck_core::readiness::{Backoff, Generation, Readiness};
use spotteck_core::state::{percent_to_volume, Payload, PlayerState, Update};
use spotteck_core::uri::{playlist_id_of, playlist_uri, track_id_of, track_uri};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// librespot's own client ID; its redirect URI is the only one registered for it.
const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
const REDIRECT_URI: &str = "http://127.0.0.1:8898/login";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOGIN_PAGE: &str = r#"<!doctype html><html lang="it"><meta charset="utf-8"><title>Spotteck</title>
<body style="font:15px -apple-system,sans-serif;background:#141413;color:#eee;display:grid;place-items:center;height:90vh">
<p>Accesso completato. Puoi chiudere questa scheda e tornare a Spotteck.</p></body></html>"#;

const NOT_RESPONDING: &str = "Il lettore Spotify non risponde. Riprova tra poco.";
const NOTHING_PLAYING: &str = "Avvia una playlist su Spotteck.";

/// Where the reusable login is kept (the macOS Keychain in the app).
pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, secret: &str) -> Result<(), String>;
    fn delete(&self);
}

pub struct EngineConfig {
    pub device_name: String,
    /// Stable per installation, so other Spotify apps keep seeing the same device.
    pub device_id: String,
    pub tmp_dir: PathBuf,
    pub credentials: Arc<dyn CredentialStore>,
    pub on_state: Box<dyn Fn(Payload) + Send + Sync>,
    pub tap: Arc<AudioTap>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Profile {
    pub name: String,
    pub product: String,
    pub avatar: String,
}

#[derive(Clone)]
struct Link {
    epoch: u64,
    session: Session,
    spirc: Arc<Spirc>,
    mixer: Arc<dyn Mixer>,
}

enum ConnectError {
    PlanUnsupported,
    BadCredentials,
    Transient(String),
}

fn classify(error: &Error) -> ConnectError {
    let text = error.to_string();
    if text.contains("Premium account required") {
        ConnectError::PlanUnsupported
    } else if text.contains("Bad credentials") {
        ConnectError::BadCredentials
    } else {
        ConnectError::Transient(text)
    }
}

#[derive(Clone)]
pub struct Engine(Arc<Inner>);

struct Inner {
    config: EngineConfig,
    state: Mutex<PlayerState>,
    generation: Generation,
    link: Mutex<Option<Link>>,
    library: Library,
    last_request: Mutex<Option<(String, Option<String>)>>,
    native_mode: std::sync::atomic::AtomicBool,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Engine {
        Engine(Arc::new(Inner {
            config,
            state: Mutex::new(PlayerState::default()),
            generation: Generation::default(),
            link: Mutex::new(None),
            library: Library::default(),
            last_request: Mutex::new(None),
            // Spotify refuses audio keys to librespot on this account: on macOS, drive the
            // official app from the start instead of waiting for the first failure.
            native_mode: std::sync::atomic::AtomicBool::new(
                cfg!(target_os = "macos") && std::path::Path::new("/Applications/Spotify.app").exists(),
            ),
        }))
    }

    pub fn payload(&self) -> Payload {
        self.0.state.lock().unwrap().payload(Instant::now())
    }

    pub fn readiness(&self) -> Readiness {
        self.0.state.lock().unwrap().readiness.clone()
    }

    fn notify(&self) {
        let payload = self.payload();
        (self.0.config.on_state)(payload);
    }

    fn update(&self, epoch: u64, f: impl FnOnce(&mut PlayerState)) {
        if !self.0.generation.is_current(epoch) {
            return;
        }
        f(&mut self.0.state.lock().unwrap());
        self.notify();
    }

    fn set_readiness(&self, epoch: u64, readiness: Readiness) {
        self.update(epoch, |s| s.readiness = readiness);
    }

    /// Reconnects with the saved login, if any. Called once at startup.
    pub fn start(&self) {
        let epoch = self.0.generation.current();
        if self.0.config.credentials.load().is_none() {
            self.set_readiness(epoch, Readiness::SignedOut);
            return;
        }
        self.set_readiness(epoch, Readiness::Connecting);
        let engine = self.clone();
        tokio::spawn(async move { engine.reconnect(epoch).await });
    }

    /// Browser login. Returns once Spotteck is connected, or with an Italian error.
    pub async fn login(&self) -> Result<(), String> {
        let epoch = self.0.generation.bump();
        self.disconnect();
        self.0.library.clear();
        self.0.state.lock().unwrap().reset(Readiness::Connecting);
        self.notify();

        let client = OAuthClientBuilder::new(CLIENT_ID, REDIRECT_URI, vec!["streaming"])
            .open_in_browser()
            .with_custom_message(LOGIN_PAGE)
            .build()
            .map_err(|_| "Impossibile avviare l’accesso a Spotify.".to_owned());
        let token = match client {
            Ok(client) => match tokio::time::timeout(LOGIN_TIMEOUT, client.get_access_token_async()).await {
                Ok(Ok(token)) => Ok(token),
                Ok(Err(_)) => Err("Accesso non riuscito. Riprova.".to_owned()),
                Err(_) => Err("Accesso scaduto: completa il login nel browser entro cinque minuti.".to_owned()),
            },
            Err(e) => Err(e),
        };
        let token = match token {
            Ok(token) => token,
            Err(e) => {
                let fallback = if self.0.config.credentials.load().is_some() {
                    Readiness::EngineError
                } else {
                    Readiness::SignedOut
                };
                self.set_readiness(epoch, fallback);
                return Err(e);
            }
        };
        if !self.0.generation.is_current(epoch) {
            return Err("Accesso annullato.".into());
        }
        match self.connect(Credentials::with_access_token(token.access_token), epoch).await {
            Ok(()) => Ok(()),
            Err(ConnectError::PlanUnsupported) => {
                self.set_readiness(epoch, Readiness::PlanUnsupported);
                Err(Readiness::PlanUnsupported.message().into())
            }
            Err(ConnectError::BadCredentials) => {
                self.set_readiness(epoch, Readiness::SignedOut);
                Err("Spotify ha rifiutato l’accesso. Riprova.".into())
            }
            Err(ConnectError::Transient(_)) => {
                self.set_readiness(epoch, Readiness::EngineError);
                Err("Spotify non è raggiungibile. Controlla la connessione e riprova.".into())
            }
        }
    }

    /// Stops playback, forgets the saved login and clears the library cache.
    pub fn logout(&self) {
        self.0.generation.bump();
        self.disconnect();
        self.0.config.credentials.delete();
        self.0.library.clear();
        self.0.state.lock().unwrap().reset(Readiness::SignedOut);
        self.notify();
    }

    /// Shuts the current session down, e.g. when the app quits.
    pub fn disconnect(&self) {
        if let Some(link) = self.0.link.lock().unwrap().take() {
            let _ = link.spirc.shutdown();
            link.session.shutdown();
        }
    }

    async fn reconnect(&self, epoch: u64) {
        let mut backoff = Backoff::default();
        while self.0.generation.is_current(epoch) {
            let Some(saved) = self.0.config.credentials.load() else {
                self.set_readiness(epoch, Readiness::SignedOut);
                return;
            };
            let Ok(credentials) = serde_json::from_str::<Credentials>(&saved) else {
                self.0.config.credentials.delete();
                self.set_readiness(epoch, Readiness::SignedOut);
                return;
            };
            match self.connect(credentials, epoch).await {
                Ok(()) => return,
                Err(ConnectError::PlanUnsupported) => return self.set_readiness(epoch, Readiness::PlanUnsupported),
                Err(ConnectError::BadCredentials) => {
                    self.0.config.credentials.delete();
                    return self.set_readiness(epoch, Readiness::SignedOut);
                }
                Err(ConnectError::Transient(e)) => {
                    log::warn!("Spotify connection failed: {e}");
                    // Keep showing what we had; the next attempt follows the backoff.
                    self.set_readiness(epoch, Readiness::Connecting);
                    tokio::time::sleep(backoff.next_delay()).await;
                }
            }
        }
    }

    async fn connect(&self, credentials: Credentials, epoch: u64) -> Result<(), ConnectError> {
        let config = &self.0.config;
        let session = Session::new(
            SessionConfig {
                device_id: config.device_id.clone(),
                tmp_dir: config.tmp_dir.clone(),
                ..SessionConfig::default()
            },
            None,
        );
        let mixer: Arc<dyn Mixer> =
            Arc::new(SoftMixer::open(MixerConfig::default()).map_err(|e| ConnectError::Transient(e.to_string()))?);
        let backend = audio_backend::find(None).ok_or_else(|| ConnectError::Transient("no audio backend".into()))?;
        let tap = config.tap.clone();
        let sink_volume = mixer.get_soft_volume();
        let player = Player::new(
            PlayerConfig {
                bitrate: Bitrate::Bitrate320,
                position_update_interval: Some(Duration::from_secs(1)),
                ..PlayerConfig::default()
            },
            session.clone(),
            mixer.get_soft_volume(),
            move || Box::new(TeeSink::new(backend(None, AudioFormat::default()), tap, sink_volume)),
        );
        let events = player.get_player_event_channel();
        let volume = self.0.state.lock().unwrap().volume;
        let connect = ConnectConfig {
            name: config.device_name.clone(),
            device_type: DeviceType::Computer,
            initial_volume: volume,
            ..ConnectConfig::default()
        };
        let (spirc, task) =
            Spirc::new(connect, session.clone(), credentials, player, mixer.clone()).await.map_err(|e| classify(&e))?;

        if !self.0.generation.is_current(epoch) {
            let _ = spirc.shutdown();
            session.shutdown();
            return Ok(());
        }

        let reusable = Credentials {
            username: Some(session.username()),
            auth_type: AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS,
            auth_data: session.auth_data(),
        };
        if let Ok(secret) = serde_json::to_string(&reusable) {
            if let Err(e) = config.credentials.save(&secret) {
                log::warn!("Could not save the Spotify login: {e}");
            }
        }

        let plan = session.get_user_attribute("type");
        *self.0.link.lock().unwrap() = Some(Link { epoch, session: session.clone(), spirc: Arc::new(spirc), mixer });
        self.set_readiness(epoch, Readiness::from_plan(plan.as_deref()));

        let engine = self.clone();
        tokio::spawn(async move { engine.forward_events(events, epoch).await });
        let engine = self.clone();
        tokio::spawn(async move {
            task.await;
            engine.on_session_closed(epoch, &session).await;
        });
        Ok(())
    }

    async fn on_session_closed(&self, epoch: u64, session: &Session) {
        {
            let mut link = self.0.link.lock().unwrap();
            match link.as_ref() {
                Some(current) if current.epoch == epoch && current.session.session_id() == session.session_id() => {
                    *link = None
                }
                _ => return,
            }
        }
        if !self.0.generation.is_current(epoch) {
            return;
        }
        log::warn!("Spotify session closed; reconnecting");
        self.update(epoch, |s| {
            s.apply(Update::Stopped, Instant::now());
            s.readiness = Readiness::Connecting;
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        self.clone().reconnect_boxed(epoch).await;
    }

    /// `reconnect` → `connect` → `on_session_closed` → `reconnect` is a cycle; the box
    /// gives it a nameable `Send` type.
    fn reconnect_boxed(self, epoch: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move { self.reconnect(epoch).await })
    }

    async fn forward_events(&self, mut events: PlayerEventChannel, epoch: u64) {
        while let Some(event) = events.recv().await {
            if !self.0.generation.is_current(epoch) {
                return;
            }
            // Spotify.app owns playback: idle librespot events would wipe its state.
            if self.is_native_mode() {
                continue;
            }
            let update = match event {
                PlayerEvent::TrackChanged { audio_item } => track_update(&audio_item),
                PlayerEvent::Playing { position_ms, .. } => Update::Playing { position_ms },
                PlayerEvent::Paused { position_ms, .. } => Update::Paused { position_ms },
                PlayerEvent::PositionChanged { position_ms, .. }
                | PlayerEvent::PositionCorrection { position_ms, .. }
                | PlayerEvent::Seeked { position_ms, .. } => Update::Position { position_ms },
                PlayerEvent::Stopped { .. } => Update::Stopped,
                PlayerEvent::ShuffleChanged { shuffle } => Update::Shuffle(shuffle),
                PlayerEvent::VolumeChanged { volume } => Update::Volume(volume),
                PlayerEvent::Unavailable { .. } => {
                    log::warn!("librespot track unavailable (audio key refused); triggering native Spotify controller fallback");
                    #[cfg(target_os = "macos")]
                    {
                        let last = self.0.last_request.lock().unwrap().clone();
                        if let Some((ctx, trk)) = last {
                            if let Ok(()) = self.play_macos_native(&ctx, trk.as_deref()).await {
                                continue;
                            }
                        }
                    }
                    Update::Error("Brano non disponibile su Spotify.".into())
                }
                _ => continue,
            };
            self.update(epoch, |s| s.apply(update, Instant::now()));
        }
    }

    fn link(&self) -> Result<Link, String> {
        self.readiness().gate()?;
        self.0.link.lock().unwrap().clone().ok_or_else(|| Readiness::Connecting.message().to_owned())
    }

    fn active(&self) -> bool {
        self.0.state.lock().unwrap().active
    }

    fn send(result: Result<(), Error>) -> Result<(), String> {
        result.map_err(|_| NOT_RESPONDING.to_owned())
    }

    pub fn is_native_mode(&self) -> bool {
        self.0.native_mode.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub async fn play_macos_native(&self, context: &str, track: Option<&str>) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            use spotteck_core::uri::{playlist_id_of, playlist_uri, track_id_of, track_uri};
            let ctx_uri = playlist_id_of(context).map(|id| playlist_uri(&id)).unwrap_or_else(|| context.to_string());
            let mut trk_uri = track.and_then(|t| track_id_of(t).map(|id| track_uri(&id)));

            // Passing `play track <playlist>` without a track URI causes Spotify.app to start
            // playing at 0:00 for ~0.5s and then jump/restart once its context resolver finishes.
            // Resolving the entry track URI upfront starts `play track <track> in context <playlist>`
            // cleanly from 0:00 with zero stutter or restart.
            if trk_uri.is_none() {
                let shuffling = self.0.state.lock().unwrap().shuffling;
                let session = self.0.link.lock().unwrap().as_ref().map(|l| l.session.clone());
                if let Some(session) = session {
                    trk_uri = self.0.library.entry_track(&session, &ctx_uri, shuffling).await;
                }
            }

            self.0.native_mode.store(true, std::sync::atomic::Ordering::Relaxed);
            self.0.state.lock().unwrap().context_uri = ctx_uri.clone();

            let engine = self.clone();
            tokio::task::spawn_blocking(move || {
                crate::controller::play_uri(&ctx_uri, trk_uri.as_deref())?;
                engine.sync_macos_state();
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (context, track);
            Err("Native Spotify fallback is only supported on macOS.".into())
        }
    }

    pub fn sync_macos_state(&self) {
        #[cfg(target_os = "macos")]
        if let Some(state) = crate::controller::get_state() {
            let now = Instant::now();
            let mut st = self.0.state.lock().unwrap();
            st.readiness = Readiness::Ready;
            st.active = true;
            st.playing = state.is_playing;
            if !state.track.is_empty() {
                st.track = state.track;
                st.artist = state.artist;
                st.album = state.album;
            }
            if !state.track_uri.is_empty() {
                st.track_uri = state.track_uri;
            }
            if !state.artwork.is_empty() {
                st.artwork = state.artwork;
            }
            if state.duration_ms > 0 {
                st.duration_ms = state.duration_ms;
            }
            st.set_position(state.position_ms, now);
            st.shuffling = state.shuffling;
            st.volume = percent_to_volume(state.volume as f64);
            st.playback_error = None;

            self.0.config.tap.set_synthetic_active(state.is_playing);

            drop(st);
            self.notify();
        }
    }

    /// Plays or pauses here. When another device is playing, playback moves to Spotteck.
    pub fn play_pause(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            crate::controller::play_pause()?;
            self.sync_macos_state();
            return Ok(());
        }
        let link = self.link()?;
        Self::send(if self.active() { link.spirc.play_pause() } else { link.spirc.transfer(None) })
    }

    pub fn next(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            crate::controller::next()?;
            self.sync_macos_state();
            return Ok(());
        }
        let link = self.link()?;
        if !self.active() {
            return Err(NOTHING_PLAYING.into());
        }
        Self::send(link.spirc.next())
    }

    pub fn prev(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            crate::controller::prev()?;
            self.sync_macos_state();
            return Ok(());
        }
        let link = self.link()?;
        if !self.active() {
            return Err(NOTHING_PLAYING.into());
        }
        Self::send(link.spirc.prev())
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            let s = if seconds.is_finite() { seconds.max(0.0) as u32 } else { 0 };
            crate::controller::seek(s)?;
            self.sync_macos_state();
            return Ok(());
        }
        let link = self.link()?;
        if !self.active() {
            return Err(NOTHING_PLAYING.into());
        }
        let ms = if seconds.is_finite() { (seconds.max(0.0) * 1000.0).min(f64::from(u32::MAX)) as u32 } else { 0 };
        Self::send(link.spirc.set_position_ms(ms))?;
        self.update(link.epoch, |s| s.apply(Update::Position { position_ms: ms }, Instant::now()));
        Ok(())
    }

    /// 0–100. Works before anything plays, so playback starts at the chosen level.
    pub fn set_volume(&self, percent: f64) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            let v = percent.clamp(0.0, 100.0).round() as u8;
            crate::controller::set_volume(v)?;
            let volume = percent_to_volume(percent);
            self.0.state.lock().unwrap().volume = volume;
            self.notify();
            return Ok(());
        }
        let link = self.link()?;
        let volume = percent_to_volume(percent);
        if self.active() {
            Self::send(link.spirc.set_volume(volume))?;
        } else {
            link.mixer.set_volume(volume);
        }
        self.update(link.epoch, |s| s.apply(Update::Volume(volume), Instant::now()));
        Ok(())
    }

    pub fn set_shuffle(&self, shuffle: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            crate::controller::set_shuffle(shuffle)?;
            self.0.state.lock().unwrap().shuffling = shuffle;
            self.notify();
            return Ok(());
        }
        let link = self.link()?;
        if self.active() {
            Self::send(link.spirc.shuffle(shuffle))?;
        }
        self.update(link.epoch, |s| s.apply(Update::Shuffle(shuffle), Instant::now()));
        Ok(())
    }

    /// Starts a playlist here, from `track` if given, honouring the shuffle switch.
    pub async fn play(&self, context: &str, track: Option<&str>) -> Result<(), String> {
        *self.0.last_request.lock().unwrap() = Some((context.to_string(), track.map(|t| t.to_string())));
        #[cfg(target_os = "macos")]
        if self.is_native_mode() {
            return self.play_macos_native(context, track).await;
        }
        let link = self.link()?;
        let context = playlist_id_of(context).map(|id| playlist_uri(&id)).ok_or("Playlist non valida.")?;
        let playing_track = match track {
            Some(t) => Some(PlayingTrack::Uri(track_uri(&track_id_of(t).ok_or("Brano non valido.")?))),
            None => None,
        };
        let (shuffling, volume) = {
            let state = self.0.state.lock().unwrap();
            (state.shuffling, state.volume)
        };
        let shuffle = shuffling && playing_track.is_none();
        let request = LoadRequest::from_context_uri(
            context.clone(),
            LoadRequestOptions {
                start_playing: true,
                seek_to: 0,
                context_options: Some(LoadContextOptions::Options(Options { shuffle, ..Options::default() })),
                playing_track,
            },
        );
        // Activation is ignored when Spotteck is already the active device. It reports the
        // device's last connect volume, so the slider's current level is sent right after.
        Self::send(link.spirc.activate())?;
        Self::send(link.spirc.set_volume(volume))?;
        Self::send(link.spirc.load(request))?;
        self.update(link.epoch, |s| s.apply(Update::Context(context), Instant::now()));
        Ok(())
    }

    pub async fn profile(&self) -> Option<Profile> {
        let link = self.0.link.lock().unwrap().clone()?;
        let session = &link.session;
        let username = session.username();
        let product = match session.get_user_attribute("type").as_deref() {
            Some("premium") | None => "Premium".to_owned(),
            Some(other) => {
                let mut chars = other.chars();
                chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
            }
        };
        let mut profile = Profile { name: username.clone(), product, avatar: String::new() };
        if let Ok(bytes) = session.spclient().get_user_profile(&username, Some(0), Some(0)).await {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(name) = json["name"].as_str().filter(|n| !n.is_empty()) {
                    profile.name = name.to_owned();
                }
                if let Some(url) = json["image_url"].as_str().filter(|u| u.starts_with("https://")) {
                    profile.avatar = url.to_owned();
                }
            }
        }
        self.0.generation.is_current(link.epoch).then_some(profile)
    }

    fn session(&self) -> Result<(u64, Session), String> {
        self.link().map(|l| (l.epoch, l.session))
    }

    pub async fn playlists(&self) -> Result<Vec<PlaylistEntry>, String> {
        let (epoch, session) = self.session()?;
        let list = self.0.library.playlists(&session).await?;
        if !self.0.generation.is_current(epoch) {
            return Err("Account cambiato.".into());
        }
        Ok(list)
    }

    pub async fn playlist(&self, id: &str) -> Result<PlaylistEntry, String> {
        let (epoch, session) = self.session()?;
        let entry = self.0.library.summary(&session, id).await?;
        if !self.0.generation.is_current(epoch) {
            return Err("Account cambiato.".into());
        }
        Ok(entry)
    }

    pub async fn tracks(&self, id: &str) -> Result<Vec<TrackEntry>, String> {
        let (epoch, session) = self.session()?;
        let tracks = self.0.library.tracks(&session, id).await?;
        if !self.0.generation.is_current(epoch) {
            return Err("Account cambiato.".into());
        }
        Ok(tracks)
    }
}

fn track_update(item: &AudioItem) -> Update {
    let (artist, album) = match &item.unique_fields {
        UniqueFields::Track { artists, album, .. } => {
            (artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "), album.clone())
        }
        UniqueFields::Local { artists, album, .. } => {
            (artists.clone().unwrap_or_default(), album.clone().unwrap_or_default())
        }
        UniqueFields::Episode { show_name, .. } => (show_name.clone(), String::new()),
    };
    Update::Track {
        uri: item.uri.clone(),
        name: item.name.clone(),
        artist,
        album,
        artwork: pick_cover(item.covers.iter().map(|c| (c.url.as_str(), c.width))).unwrap_or_default(),
        duration_ms: item.duration_ms,
    }
}
