use serde::{Deserialize, Serialize};
use std::path::Path;

use sidex_workspace::search::{
    search_files as crate_search_files, FileSearchOptions as CrateFileSearchOptions, SearchEngine,
    SearchOptions as CrateSearchOptions, SearchQuery as CrateSearchQuery,
};

use super::validation::validate_path;

#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub score: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextMatch {
    pub path: String,
    pub line_number: usize,
    pub line_content: String,
    pub column: usize,
    pub match_length: usize,
}

#[derive(Debug, Deserialize)]
pub struct SearchFileOptions {
    pub max_results: Option<usize>,
    pub include_hidden: Option<bool>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SearchTextOptions {
    pub max_results: Option<usize>,
    pub case_sensitive: Option<bool>,
    pub is_regex: Option<bool>,
    #[allow(dead_code)]
    pub include_hidden: Option<bool>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
    pub max_file_size: Option<u64>,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)]
pub fn search_files(
    root: String,
    pattern: String,
    options: Option<SearchFileOptions>,
) -> Result<Vec<FileMatch>, String> {
    validate_path(&root)?;
    let crate_opts = options.map(|o| CrateFileSearchOptions {
        max_results: o.max_results,
        include_hidden: o.include_hidden,
        include: o.include,
        exclude: o.exclude,
    });

    let matches = crate_search_files(Path::new(&root), &pattern, crate_opts.as_ref());

    Ok(matches
        .into_iter()
        .map(|m| FileMatch {
            path: m.path,
            name: m.name,
            score: m.score,
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn search_text(
    root: String,
    query: String,
    options: Option<SearchTextOptions>,
) -> Result<Vec<TextMatch>, String> {
    validate_path(&root)?;
    let opts_ref = options.as_ref();
    let query_len = query.len();

    let crate_query = CrateSearchQuery {
        pattern: query,
        is_regex: opts_ref.and_then(|o| o.is_regex).unwrap_or(false),
        case_sensitive: opts_ref.and_then(|o| o.case_sensitive).unwrap_or(false),
        whole_word: false,
        max_results: opts_ref.and_then(|o| o.max_results),
    };

    let crate_opts = CrateSearchOptions {
        include_patterns: opts_ref.and_then(|o| o.include.clone()).unwrap_or_default(),
        exclude_patterns: opts_ref.and_then(|o| o.exclude.clone()).unwrap_or_default(),
        max_results: opts_ref.and_then(|o| o.max_results),
        max_file_size: opts_ref.and_then(|o| o.max_file_size),
        context_lines: None,
    };

    let results = SearchEngine::search_with_options(Path::new(&root), &crate_query, &crate_opts)
        .map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|r| TextMatch {
            path: r.path.to_string_lossy().into_owned(),
            line_number: r.line_number,
            line_content: r.line_text,
            column: r.match_start,
            match_length: r.match_end.saturating_sub(r.match_start).max(query_len),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Commands backed directly by sidex-workspace::SearchEngine (grouped / replace)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct WorkspaceSearchOptions {
    pub case_sensitive: Option<bool>,
    pub is_regex: Option<bool>,
    pub whole_word: Option<bool>,
    pub max_results: Option<usize>,
    pub max_file_size: Option<u64>,
    pub include_patterns: Option<Vec<String>>,
    pub exclude_patterns: Option<Vec<String>>,
    pub context_lines: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsSearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsContextLine {
    pub line_number: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsMatchWithContext {
    pub line_number: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
    pub before_context: Vec<WsContextLine>,
    pub after_context: Vec<WsContextLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsSearchGroup {
    pub file_path: String,
    pub matches: Vec<WsMatchWithContext>,
    pub line_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsReplacementEdit {
    pub line_number: usize,
    pub match_start: usize,
    pub match_end: usize,
    pub original: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsFileReplacement {
    pub path: String,
    pub edits: Vec<WsReplacementEdit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsReplaceReport {
    pub files_modified: u32,
    pub replacements_made: u32,
    pub errors: Vec<(String, String)>,
}

fn build_ws_query(query: &str, options: Option<&WorkspaceSearchOptions>) -> CrateSearchQuery {
    CrateSearchQuery {
        pattern: query.to_string(),
        is_regex: options.and_then(|o| o.is_regex).unwrap_or(false),
        case_sensitive: options.and_then(|o| o.case_sensitive).unwrap_or(false),
        whole_word: options.and_then(|o| o.whole_word).unwrap_or(false),
        max_results: options.and_then(|o| o.max_results),
    }
}

fn build_ws_options(options: Option<&WorkspaceSearchOptions>) -> CrateSearchOptions {
    CrateSearchOptions {
        include_patterns: options
            .and_then(|o| o.include_patterns.clone())
            .unwrap_or_default(),
        exclude_patterns: options
            .and_then(|o| o.exclude_patterns.clone())
            .unwrap_or_default(),
        max_results: options.and_then(|o| o.max_results),
        max_file_size: options.and_then(|o| o.max_file_size),
        context_lines: options.and_then(|o| o.context_lines),
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn search_workspace(
    root: String,
    query: String,
    options: Option<WorkspaceSearchOptions>,
) -> Result<Vec<WsSearchMatch>, String> {
    validate_path(&root)?;
    let ws_query = build_ws_query(&query, options.as_ref());
    let ws_opts = build_ws_options(options.as_ref());

    let results = SearchEngine::search_with_options(Path::new(&root), &ws_query, &ws_opts)
        .map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|r| WsSearchMatch {
            path: r.path.to_string_lossy().into_owned(),
            line_number: r.line_number,
            line_text: r.line_text,
            match_start: r.match_start,
            match_end: r.match_end,
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn search_workspace_grouped(
    root: String,
    query: String,
    options: Option<WorkspaceSearchOptions>,
) -> Result<Vec<WsSearchGroup>, String> {
    validate_path(&root)?;
    let ws_query = build_ws_query(&query, options.as_ref());
    let ws_opts = build_ws_options(options.as_ref());

    let groups = SearchEngine::search_grouped(Path::new(&root), &ws_query, &ws_opts)
        .map_err(|e| e.to_string())?;

    Ok(groups
        .into_iter()
        .map(|g| WsSearchGroup {
            file_path: g.file_path.to_string_lossy().into_owned(),
            line_count: g.line_count,
            matches: g
                .matches
                .into_iter()
                .map(|m| WsMatchWithContext {
                    line_number: m.line_number,
                    line_text: m.line_text,
                    match_start: m.match_start,
                    match_end: m.match_end,
                    before_context: m
                        .before_context
                        .into_iter()
                        .map(|c| WsContextLine {
                            line_number: c.line_number,
                            text: c.text,
                        })
                        .collect(),
                    after_context: m
                        .after_context
                        .into_iter()
                        .map(|c| WsContextLine {
                            line_number: c.line_number,
                            text: c.text,
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn search_workspace_replace_preview(
    root: String,
    query: String,
    replacement: String,
    options: Option<WorkspaceSearchOptions>,
) -> Result<Vec<WsFileReplacement>, String> {
    validate_path(&root)?;
    let ws_query = build_ws_query(&query, options.as_ref());

    let replacements = SearchEngine::replace_in_files(Path::new(&root), &ws_query, &replacement)
        .map_err(|e| e.to_string())?;

    Ok(replacements
        .into_iter()
        .map(|fr| WsFileReplacement {
            path: fr.path.to_string_lossy().into_owned(),
            edits: fr
                .edits
                .into_iter()
                .map(|e| WsReplacementEdit {
                    line_number: e.line_number,
                    match_start: e.match_start,
                    match_end: e.match_end,
                    original: e.original,
                    replacement: e.replacement,
                })
                .collect(),
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn search_workspace_replace_apply(
    root: String,
    query: String,
    replacement: String,
) -> Result<WsReplaceReport, String> {
    validate_path(&root)?;
    let ws_query = CrateSearchQuery {
        pattern: query,
        is_regex: false,
        case_sensitive: true,
        whole_word: false,
        max_results: None,
    };

    let report =
        SearchEngine::replace_in_files_with_report(Path::new(&root), &ws_query, &replacement)
            .map_err(|e| e.to_string())?;

    Ok(WsReplaceReport {
        files_modified: report.files_modified,
        replacements_made: report.replacements_made,
        errors: report
            .errors
            .into_iter()
            .map(|(p, e)| (p.to_string_lossy().into_owned(), e))
            .collect(),
    })
}
