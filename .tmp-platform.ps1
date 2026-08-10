$ErrorActionPreference = 'Stop'

function Replace-Crlf([string]$path, [string]$old, [string]$new) {
    $content = [System.IO.File]::ReadAllText($path)
    $idx = $content.IndexOf($old)
    if ($idx -lt 0) { throw "anchor not found in $path" }
    $content = $content.Replace($old, $new)
    [System.IO.File]::WriteAllText($path, $content)
    Write-Output "patched $path"
}

$nl = "`r`n"

# 1. tauri.conf.json: drop macOS + linux bundle sections
$p = 'src-tauri\tauri.conf.json'
Replace-Crlf $p (
    "    `"macOS`": {$nl      `"signingIdentity`": `"Developer ID Application: kima Booker (D983H3RN86)`",$nl      `"entitlements`": `"entitlements.plist`",$nl      `"minimumSystemVersion`": `"10.15`"$nl    },$nl    `"windows`": {$nl      `"webviewInstallMode`": {$nl        `"type`": `"downloadBootstrapper`"$nl      }$nl    },$nl    `"linux`": {$nl      `"deb`": {$nl        `"depends`": [$nl          `"libwebkit2gtk-4.1-0`",$nl          `"libgtk-3-0`"$nl        ]$nl      },$nl      `"rpm`": {$nl        `"depends`": [$nl          `"webkit2gtk4.1`",$nl          `"gtk3`"$nl        ]$nl      }$nl    }$nl  }$nl}"
) (
    "    `"windows`": {$nl      `"webviewInstallMode`": {$nl        `"type`": `"downloadBootstrapper`"$nl      }$nl    }$nl  }$nl}"
)

# 2. src-tauri/Cargo.toml: drop libc unix dep and macos_fsevent notify feature
$p = 'src-tauri\Cargo.toml'
Replace-Crlf $p (
    "notify = { version = `"7`", features = [`"macos_fsevent`"] }"
) (
    "notify = `"7`""
)
Replace-Crlf $p (
    "[target.'cfg(unix)'.dependencies]${nl}libc = `"0.2`"${nl}${nl}"
) (
    ""
)

# 3. main.rs: drop linux WEBKIT block
$p = 'src-tauri\src\main.rs'
Replace-Crlf $p (
    "fn main() {$nl    #[cfg(target_os = `"linux`")]$nl    {$nl        std::env::set_var(`"WEBKIT_DISABLE_DMABUF_RENDERER`", `"1`");$nl    }$nl$nl    sidex_lib::run();$nl}"
) (
    "fn main() {$nl    sidex_lib::run();$nl}"
)

# 4. lint-rust.yml: windows-2022 runner, drop Linux system deps
$p = '.github\workflows\lint-rust.yml'
Replace-Crlf $p (
    "  clippy:$nl    name: Clippy$nl    runs-on: ubuntu-latest$nl    steps:$nl      - uses: actions/checkout@v4$nl$nl      - name: Install Linux system dependencies$nl        run: |$nl          sudo apt-get update$nl          sudo apt-get install -y \`$nl            libwebkit2gtk-4.1-dev \`$nl            libgtk-3-dev \`$nl            libayatana-appindicator3-dev \`$nl            librsvg2-dev \`$nl            libssl-dev$nl$nl      - name: Install Rust stable"
) (
    "  clippy:$nl    name: Clippy$nl    runs-on: windows-2022$nl    steps:$nl      - uses: actions/checkout@v4$nl$nl      - name: Install Rust stable"
)

# 5. udeps.yml: windows-2022 runner, drop Linux system deps
$p = '.github\workflows\udeps.yml'
Replace-Crlf $p (
    "  cargo-udeps:$nl    name: cargo-udeps$nl    runs-on: ubuntu-latest$nl    steps:$nl      - uses: actions/checkout@v4$nl$nl      - name: Install Linux system dependencies$nl        run: |$nl          sudo apt-get update$nl          sudo apt-get install -y \`$nl            libwebkit2gtk-4.1-dev \`$nl            libgtk-3-dev \`$nl            libayatana-appindicator3-dev \`$nl            librsvg2-dev \`$nl            libssl-dev$nl$nl      - name: Install Rust nightly"
) (
    "  cargo-udeps:$nl    name: cargo-udeps$nl    runs-on: windows-2022$nl    steps:$nl      - uses: actions/checkout@v4$nl$nl      - name: Install Rust nightly"
)

# 6. Delete macOS-only files
Remove-Item -Force 'src-tauri\tauri.macos.conf.json' -ErrorAction SilentlyContinue
Remove-Item -Force 'src-tauri\entitlements.plist' -ErrorAction SilentlyContinue
Write-Output 'deleted macos files'
Write-Output 'done'
