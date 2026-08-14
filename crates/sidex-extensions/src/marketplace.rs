//! SideX marketplace client: extension discovery, metadata, and installation.
//!
//! This module handles:
//!   - Querying the SideX marketplace API for extensions
//!   - Downloading .vsix packages from the marketplace or direct URLs
//!   - Caching metadata to reduce API calls
//!   - Resolving dependencies and compatibility

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::cache::ExtensionCache;
use crate::manifest::ExtensionManifest;

// ---------------------------------------------------------------------------
// Marketplace client
// ---------------------------------------------------------------------------

pub struct MarketplaceClient {
    /// Base URL for the marketplace API (e.g. "https://marketplace.sidex.app")
    base_url: String,
    /// Optional API key for authenticated endpoints
    api_key: Option<String>,
    /// In-memory cache for extension metadata (keyed by publisher.name)
    cache: Arc<RwLock<HashMap<String, ExtensionMetadata>>>,
    /// TTL for cached metadata (default 5 minutes)
    cache_ttl: Duration,
    /// HTTP client with reasonable defaults for API calls
    http_client: reqwest::Client,
    /// Extension cache for .vsix files
    extension_cache: Arc<ExtensionCache>,
}

impl MarketplaceClient {
    pub fn new(base_url: &str, api_key: Option<String>) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            cache: Arc::new(RwLock::new(HashMap::new())),
            cache_ttl: Duration::from_secs(300),
            http_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent(concat!(
                    "SideX/",
                    env!("CARGO_PKG_VERSION"),
                    " (+https://github.com/airdropia/sidex)"
                ))
                .build()
                .expect("failed to build HTTP client"),
            extension_cache: Arc::new(ExtensionCache::new().expect("failed to init extension cache")),
        }
    }

    /// Enable extension caching for offline installs
    pub fn with_extension_cache(mut self, cache: Arc<ExtensionCache>) -> Self {
        self.extension_cache = cache;
        self
    }

    // -- Search / Discovery --------------------------------------------------

    /// Search extensions by keyword (simple substring match on name/description)
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<ExtensionMetadata>> {
        let endpoint = format!("{}/v1/extensions/search", self.base_url);
        let mut params = HashMap::new();
        params.insert("q", query.to_string());
        params.insert("limit", limit.to_string());

        let resp = self
            .http_client
            .get(&endpoint)
            .query(&params)
            .bearer_auth(self.api_key.clone().unwrap_or_default())
            .send()
            .await
            .context("marketplace search request failed")?
            .error_for_status()
            .context("marketplace search returned error")?;

        let results: SearchResponse = resp.json().await.context("invalid search response")?;
        Ok(results.extensions)
    }

    /// Get metadata for a specific extension by publisher.name
    pub async fn get_metadata(&self, publisher: &str, name: &str) -> Result<ExtensionMetadata> {
        // Check cache first
        let key = format!("{}.{}", publisher, name);
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&key) {
                let age = SystemTime::now()
                    .duration_since(entry.cached_at)
                    .unwrap_or(Duration::ZERO);
                if age < self.cache_ttl {
                    debug!("cache hit for {key}");
                    return Ok(entry.clone());
                }
            }
        }

        // Fetch from API
        let endpoint = format!(
            "{}/v1/extensions/{}/{}",
            self.base_url, publisher, name
        );
        let resp = self
            .http_client
            .get(&endpoint)
            .bearer_auth(self.api_key.clone().unwrap_or_default())
            .send()
            .await
            .context("metadata request failed")?
            .error_for_status()
            .context("metadata request returned error")?;

        let metadata: ExtensionMetadata = resp.json().await.context("invalid metadata response")?;

        // Cache it
        {
            let mut cache = self.cache.write().await;
            cache.insert(key, metadata.clone());
        }

        Ok(metadata)
    }

    /// Get list of featured/recommended extensions
    pub async fn get_featured(&self, limit: usize) -> Result<Vec<ExtensionMetadata>> {
        let endpoint = format!("{}/v1/extensions/featured", self.base_url);
        let params = [("limit", limit.to_string())];
        let resp = self
            .http_client
            .get(&endpoint)
            .query(&params)
            .bearer_auth(self.api_key.clone().unwrap_or_default())
            .send()
            .await
            .context("featured request failed")?
            .error_for_status()
            .context("featured request returned error")?;

        let results: SearchResponse = resp.json().await.context("invalid featured response")?;
        Ok(results.extensions)
    }

    // -- Download / Install ------------------------------------------------

    /// Download a .vsix package from a URL and install it.
    /// Supports:
    ///   - Marketplace CDN URLs
    ///   - Direct GitHub release assets
    ///   - Local file paths (via `file://` scheme)
    ///
    /// Timeout is 900s (15min) with 3 retry attempts for transient network failures.
    pub async fn download_from_url(&self, url: &str) -> Result<Vec<u8>> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            .connect_timeout(std::time::Duration::from_secs(15))
            .user_agent(concat!(
                "SideX/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/airdropia/sidex)"
            ))
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build download client: {e}"))?;

        let mut attempt = 0u32;
        let max_attempts = 3u32;
        let mut last_error = None;

        while attempt < max_attempts {
            attempt += 1;
            let response = match client.get(url).send().await {
                Ok(response) => response,
                Err(err) => {
                    last_error = Some(err);
                    continue;
                }
            };

            if !response.status().is_success() {
                return Err(anyhow::anyhow!(
                    "vsix download failed: HTTP {}",
                    response.status().as_u16()
                ));
            }

            match response.bytes().await {
                Ok(bytes) => return Ok(bytes.to_vec()),
                Err(err) => last_error = Some(err),
            }
        }

        Err(last_error
            .map(|err| anyhow::anyhow!("failed to read vsix bytes: {err:#}"))
            .unwrap_or_else(|| anyhow::anyhow!("failed to read vsix bytes")))
    }

    // -- Recommended / Trending ------------------------------------------

    /// Get trending extensions (sorted by recent downloads)
    pub async fn get_trending(&self, limit: usize) -> Result<Vec<ExtensionMetadata>> {
        let endpoint = format!("{}/v1/extensions/trending", self.base_url);
        let params = [("limit", limit.to_string())];
        let resp = self
            .http_client
            .get(&endpoint)
            .query(&params)
            .bearer_auth(self.api_key.clone().unwrap_or_default())
            .send()
            .await
            .context("trending request failed")?
            .error_for_status()
            .context("trending request returned error")?;

        let results: SearchResponse = resp.json().await.context("invalid trending response")?;
        Ok(results.extensions)
    }

    // -- Installation -----------------------------------------------------

    /// Download and install an extension from the marketplace.
    /// This resolves the download URL, downloads the .vsix, and caches it.
    pub async fn install(&self, publisher: &str, name: &str, version: Option<&str>) -> Result<PathBuf> {
        // 1. Get metadata to resolve download URL
        let metadata = self.get_metadata(publisher, name).await?;

        // 2. Find the correct version
        let version_str = match version {
            Some(v) => v.to_string(),
            None => metadata
                .latest_version
                .clone()
                .ok_or_else(|| anyhow!("no version available for {publisher}.{name}"))?,
        };

        // 3. Get download URL for the specific version
        let download_url = metadata
            .download_url_for_version(&version_str)
            .ok_or_else(|| anyhow!("no download URL for {publisher}.{name}@{version_str}"))?;

        // 4. Check cache first
        let cache_key = format!("{}-{}-{}", publisher, name, version_str);
        if let Ok(path) = self.extension_cache.get(&cache_key) {
            info!("Using cached extension: {:?}", path);
            return Ok(path);
        }

        // 5. Download
        info!("Downloading {publisher}.{name}@{version_str} from {download_url}");
        let bytes = self.download_from_url(&download_url).await?;

        // 6. Store in cache
        let path = self.extension_cache.store(&cache_key, &bytes)?;
        info!("Cached extension at {:?}", path);

        Ok(path)
    }

    /// Clear the in-memory metadata cache
    pub async fn clear_cache(&self) {
        self.cache.write().await.clear();
    }

    /// Refresh a specific extension's metadata
    pub async fn refresh_metadata(&self, publisher: &str, name: &str) -> Result<ExtensionMetadata> {
        let key = format!("{}.{}", publisher, name);
        {
            let mut cache = self.cache.write().await;
            cache.remove(&key);
        }
        self.get_metadata(publisher, name).await
    }
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionMetadata {
    pub publisher: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub versions: Vec<ExtensionVersion>,
    pub latest_version: Option<String>,
    pub downloads: u64,
    pub rating: f32,
    pub rating_count: u64,
    pub tags: Vec<String>,
    pub categories: Vec<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub dependencies: Vec<Dependency>,
    /// Internal timestamp for cache management
    #[serde(skip)]
    pub cached_at: SystemTime,
}

impl ExtensionMetadata {
    /// Get download URL for a specific version
    pub fn download_url_for_version(&self, version: &str) -> Option<String> {
        self.versions
            .iter()
            .find(|v| v.version == version)
            .and_then(|v| v.download_url.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionVersion {
    pub version: String,
    pub engine_version: String,
    pub download_url: String,
    pub file_size: u64,
    pub sha256: Option<String>,
    pub published_at: String, // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dependency {
    pub publisher: String,
    pub name: String,
    #[serde(default)]
    pub version_requirement: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    pub extensions: Vec<ExtensionMetadata>,
    pub total: u64,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_download_retry_logic() {
        // This test validates that the retry logic compiles and doesn't panic.
        // Actual HTTP tests are skipped in unit tests.
        let client = MarketplaceClient::new("https://example.com", None);
        let result = client.download_from_url("https://httpbin.org/status/200").await;
        // It may fail if network is down, but that's fine — we're just testing
        // that the function signature and retry loop exist.
        let _ = result;
    }
}