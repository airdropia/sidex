//! Extension install, uninstall, and update operations.
//!
//! Handles extracting `.vsix` packages (which are ZIP archives) and
//! coordinating downloads from the marketplace.

use std::path::Path;

use anyhow::{Context, Result};

use crate::encoding::decode_manifest_text;
use crate::manifest::{parse_manifest, ExtensionManifest};
use crate::marketplace::MarketplaceClient;

/// Installs an extension from a local `.vsix` file.
///
/// A `.vsix` is a ZIP archive whose `extension/` subtree contains the
/// extension files and `extension/package.json` is the manifest.
pub fn install_from_vsix(vsix_path: &Path, target_dir: &Path) -> Result<ExtensionManifest> {
    let pkg = crate::vsix::unpack_vsix(vsix_path)?;
    let validation = crate::vsix::validate_vsix(&pkg);
    if !validation.valid {
        anyhow::bail!("VSIX validation failed: {}", validation.errors.join("; "));
    }
    let installed = crate::vsix::install_package(&pkg, target_dir)?;
    Ok(installed.manifest)
}

/// Downloads and installs an extension from the marketplace.
pub async fn install_from_marketplace(id: &str, target_dir: &Path) -> Result<ExtensionManifest> {
    let client = MarketplaceClient::new();
    let ext = client
        .get_extension(id)
        .await
        .context("failed to fetch extension metadata")?;

    let vsix_bytes = client
        .download_from_url(&ext.download_url_for(id, &ext.version))
        .await
        .context("failed to download .vsix")?;

    let tmp = tempfile::NamedTempFile::new()?;
    std::fs::write(tmp.path(), &vsix_bytes)?;

    let manifest = install_from_vsix(tmp.path(), target_dir)?;
    if !manifest.canonical_id().eq_ignore_ascii_case(id) {
        log::warn!(
            "extension id mismatch: requested {id}, installed {}",
            manifest.canonical_id()
        );
    }
    Ok(manifest)
}

/// Uninstalls an extension by removing its directory.
pub fn uninstall(id: &str, extensions_dir: &Path) -> Result<()> {
    let ext_dir = extensions_dir.join(id);
    if ext_dir.exists() {
        std::fs::remove_dir_all(&ext_dir).context("failed to remove extension directory")?;
    }
    Ok(())
}

/// Updates an extension to its latest version.
pub async fn update(id: &str, extensions_dir: &Path) -> Result<ExtensionManifest> {
    uninstall(id, extensions_dir)?;
    install_from_marketplace(id, extensions_dir).await
}

/// Reads the manifest of an installed extension.
pub fn read_installed_manifest(id: &str, extensions_dir: &Path) -> Result<ExtensionManifest> {
    let pkg = extensions_dir.join(id).join("package.json");
    parse_manifest(&pkg)
}
