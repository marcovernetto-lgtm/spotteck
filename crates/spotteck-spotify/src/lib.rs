//! Spotteck's single connection to Spotify, through librespot.

mod controller;
mod engine;
mod library;
mod tap;

pub use controller::hide_spotify;
pub use engine::{CredentialStore, Engine, EngineConfig, Profile};
pub use tap::AudioTap;
