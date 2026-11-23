//! The login page (http/login-page.ts): contract/assets/html/login.html
//! filled with the PIN mode, the token's help and the draft clearing, the
//! same bytes the Bun server sends, so the same script runs in the page.

use roamgate_base::assets::{LOGIN_HTML_TEMPLATE, TemplateValue, fill_template};

/// `&`, `<`, `>`, `"` and `'` as numeric references, as the TS escapes them.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' | '<' | '>' | '"' | '\'' => {
                out.push_str(&format!("&#{};", character as u32));
            }
            other => out.push(other),
        }
    }
    out
}

/// The page: password or PIN, the token's help when `token_command` says
/// how to print it, and the script that clears the terminal composer's
/// drafts when asked.
pub fn render_login_page(
    pin_enabled: bool,
    token_command: Option<&str>,
    clear_drafts: bool,
) -> String {
    fill_template(
        LOGIN_HTML_TEMPLATE,
        &[
            ("pin", TemplateValue::Flag(pin_enabled)),
            (
                "token",
                TemplateValue::Flag(token_command.is_some_and(|command| !command.is_empty())),
            ),
            (
                "token_command",
                TemplateValue::Text(escape_html(token_command.unwrap_or(""))),
            ),
            ("clear_drafts", TemplateValue::Flag(clear_drafts)),
        ],
    )
    .expect("the login template is filled with every tag it names")
}

#[cfg(test)]
mod tests;
