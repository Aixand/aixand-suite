use aixand_ir::{OperationIdentity, ValidationError};
use pyo3::prelude::*;
use serde::Serialize;
use std::fmt;

/// One-based Unicode columns; the end position is exclusive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SourceSpan {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompilerDiagnostic {
    pub code: String,
    pub message: String,
    pub source: SourceSpan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ir_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<OperationIdentity>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompilerError {
    pub diagnostics: Vec<CompilerDiagnostic>,
}
impl fmt::Display for CompilerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, d) in self.diagnostics.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(
                f,
                "{}:{}:{}: {}: {}",
                d.source.file, d.source.line, d.source.column, d.code, d.message
            )?;
        }
        Ok(())
    }
}
impl std::error::Error for CompilerError {}
impl From<PyErr> for CompilerError {
    fn from(error: PyErr) -> Self {
        Source::new("<parser>", "").error(None, "parser", error.to_string())
    }
}

pub(crate) struct Source<'a> {
    pub file: &'a str,
    pub text: &'a str,
}
impl<'a> Source<'a> {
    pub fn new(file: &'a str, text: &'a str) -> Self {
        Self { file, text }
    }
    pub fn span(&self, node: Option<&Bound<'_, PyAny>>) -> SourceSpan {
        let number = |name: &str, default| {
            node.and_then(|n| n.getattr(name).ok()?.extract::<usize>().ok())
                .unwrap_or(default)
        };
        let line = number("lineno", 1);
        let end_line = number("end_lineno", line);
        // CPython AST offsets count UTF-8 bytes, not characters.
        let column = |line: usize, byte: usize| {
            self.text
                .lines()
                .nth(line.saturating_sub(1))
                .and_then(|s| s.get(..byte))
                .map_or(byte + 1, |s| s.chars().count() + 1)
        };
        SourceSpan {
            file: self.file.into(),
            line,
            column: column(line, number("col_offset", 0)),
            end_line,
            end_column: column(end_line, number("end_col_offset", 0)),
        }
    }
    pub fn error(
        &self,
        node: Option<&Bound<'_, PyAny>>,
        code: &str,
        message: impl Into<String>,
    ) -> CompilerError {
        CompilerError {
            diagnostics: vec![CompilerDiagnostic {
                code: code.into(),
                message: message.into(),
                source: self.span(node),
                ir_location: None,
                invocation_id: None,
                operation: None,
            }],
        }
    }
    pub fn syntax_error(&self, py: Python<'_>, error: PyErr) -> CompilerError {
        let value = error.value(py);
        let number = |name: &str, default| {
            value
                .getattr(name)
                .and_then(|v| v.extract::<usize>())
                .unwrap_or(default)
                .max(1)
        };
        let mut result = self.error(None, "syntax", error.to_string());
        let line = number("lineno", 1);
        let column = number("offset", 1);
        let end_line = number("end_lineno", line).max(line);
        let end_column = number("end_offset", column + 1);
        result.diagnostics[0].source = SourceSpan {
            file: self.file.into(),
            line,
            column,
            end_line,
            end_column: if end_line == line {
                end_column.max(column + 1)
            } else {
                end_column
            },
        };
        result
    }
    pub fn relocate(
        &self,
        error: ValidationError,
        map: &aixand_ir::Named<SourceSpan>,
    ) -> CompilerError {
        CompilerError {
            diagnostics: error
                .0
                .into_iter()
                .map(|d| {
                    let source = map
                        .iter()
                        .filter(|(path, _)| {
                            d.location == **path || d.location.starts_with(&format!("{path}/"))
                        })
                        .max_by_key(|(path, _)| path.len())
                        .map(|(_, span)| span.clone())
                        .unwrap_or_else(|| self.span(None));
                    CompilerDiagnostic {
                        code: d.code,
                        message: d.message,
                        source,
                        ir_location: Some(d.location),
                        invocation_id: d.invocation_id,
                        operation: d.operation,
                    }
                })
                .collect(),
        }
    }
}
