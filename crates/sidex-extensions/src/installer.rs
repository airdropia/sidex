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
    let file = std::fs::File::open(vsix_path).context("failed to open .vsix file")?;
    let mut archive = zip::ZipArchive::new(file).context("failed to read .vsix as ZIP")?;

    let manifest_json = {
        let mut manifest_file = archive
            .by_name("extension/package.json")
            .context("missing extension/package.json in .vsix")?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut manifest_file, &mut buf)?;
        decode_manifest_text(&buf)?
    };

    let manifest: ExtensionManifest =
        serde_json::from_str(&manifest_json).context("invalid package.json in .vsix")?;
    let ext_dir = target_dir.join(manifest.canonical_id());
    std::fs::create_dir_all(&ext_dir)?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let name_str = name.to_string_lossy();
        let Some(rel) = name_str.strip_prefix("extension/") else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }

        let out_path = ext_dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out_file)?;
        }
    }

    Ok(manifest)
}

/// Downloads and installs an extension from the marketplace.
pub async fn install_from_marketplace(id: &str, target_dir: &Path) -> Result<ExtensionManifest> {
    let client = MarketplaceClient::new();
    let ext = client
        .get_extension(id)
        .await
        .context("failed to fetch extension metadata")?;

    let vsix_bytes = if ext.download_url.is_empty() {
        client.download_vsix_bytes(id, &ext.version).await
    } else {
        client.download_from_url(&ext.download_url).await
    }
    .context("failed to download .vsix")?;

    let tmp = tempfile::NamedTempFile::new()?;
    std::fs::write(tmp.path(), &vsix_bytes)?;

    let manifest = install_from_vsix(tmp.path(), target_dir)?;
    if !manifest.canonical_id().eq_ignore_ascii_case(id) {
        log::warn!("extension id mismatch: requested {id}, installed {}", manifest.canonical_id());
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
