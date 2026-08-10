//! CI-only network smoke test.
//!
//! Verifies the marketplace install path actually downloads a VSIX from
//! Open VSX and writes real extension files to disk. This is the exact
//! regression that shipped in early releases: the UI marked extensions as
//! "installed" while nothing was ever downloaded.
//!
//! Marked `#[ignore]` because it needs network access; CI runs it with
//! `cargo test --ignored`.

#[test]
#[ignore = "requires network; CI runs with --ignored"]
fn marketplace_install_writes_vsix_to_disk() {
    let rt = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");

    rt.block_on(async {
        let id = "formulahendry.auto-close-tag";
        let target = tempfile::TempDir::new().expect("failed to create temp dir");

        let manifest = sidex_extensions::install_from_marketplace(id, target.path())
            .await
            .expect("marketplace install should succeed");

        let canonical = manifest.canonical_id();
        assert_eq!(
            canonical, id,
            "installed extension id must match the requested id"
        );

        let ext_dir = target.path().join(&canonical);
        let pkg = ext_dir.join("package.json");
        assert!(
            pkg.exists(),
            "extension package.json must exist on disk: {}",
            pkg.display()
        );

        let file_count = std::fs::read_dir(&ext_dir)
            .expect("installed extension directory should be readable")
            .count();
        assert!(
            file_count > 1,
            "extension directory should contain more than one file, got {file_count}"
        );
    });
}

#[test]
#[ignore = "requires network; CI runs with --ignored"]
fn marketplace_client_search_hits_open_vsx() {
    let rt = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");

    rt.block_on(async {
        let mut client = sidex_extensions::MarketplaceClient::new();
        let result = client
            .search("auto-close-tag", 0, 5)
            .await
            .expect("search should succeed against open-vsx.org");

        assert!(
            !result.results.is_empty(),
            "search should return at least one result from Open VSX"
        );
        assert!(
            result
                .results
                .iter()
                .any(|ext| ext.canonical_id() == "formulahendry.auto-close-tag"),
            "expected formulahendry.auto-close-tag in search results"
        );
    });
}

#[test]
fn default_marketplace_base_url_is_open_vsx() {
    let client = sidex_extensions::MarketplaceClient::new();
    assert_eq!(
        client.base_url, "https://open-vsx.org/api",
        "marketplace must point at Open VSX, not a third-party proxy"
    );
}
#[test]
#[ignore = "requires network; CI runs with --ignored"]
fn install_list_uninstall_round_trip() {
    let rt = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");

    rt.block_on(async {
        let id = "formulahendry.auto-close-tag";
        let target = tempfile::TempDir::new().expect("failed to create temp dir");

        let manifest = sidex_extensions::install_from_marketplace(id, target.path())
            .await
            .expect("marketplace install should succeed");
        assert_eq!(manifest.canonical_id(), id);

        // Registry scan sees the installed extension on disk.
        let scanned = sidex_extensions::ExtensionRegistry::scan_directory(target.path())
            .expect("scan should succeed");
        assert!(
            scanned.iter().any(|m| m.canonical_id() == id),
            "registry must list the installed extension"
        );

        // Uninstall removes it from disk.
        sidex_extensions::uninstall(id, target.path()).expect("uninstall should succeed");
        let scanned_after = sidex_extensions::ExtensionRegistry::scan_directory(target.path())
            .expect("scan should succeed");
        assert!(
            !scanned_after.iter().any(|m| m.canonical_id() == id),
            "registry must no longer list the uninstalled extension"
        );
    });
}

#[test]
#[ignore = "requires network; CI runs with --ignored"]
fn install_kilocode_win32_x64() {
    // Regression: Kilo Code publishes platform-specific VSIX builds with
    // no universal file and files.download pointing at alpine-arm64.
    // Windows must get the win32-x64 build, and a 100+ MB download must
    // not hit the 15s search-client timeout.
    let rt = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");

    rt.block_on(async {
        let id = "kilocode.kilo-code";
        let target = tempfile::TempDir::new().expect("failed to create temp dir");

        let manifest = sidex_extensions::install_from_marketplace(id, target.path())
            .await
            .expect("kilocode install should succeed");
        assert_eq!(manifest.canonical_id(), id);

        let pkg = target.path().join(id).join("package.json");
        assert!(
            pkg.exists(),
            "kilocode package.json must exist on disk: {}",
            pkg.display()
        );
    });
}
