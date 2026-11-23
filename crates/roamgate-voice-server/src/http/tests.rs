//! The request helpers the handlers share.

use super::*;

#[test]
fn decodes_uri_components_as_javascript_does() {
    assert_eq!(decode_uri_component("l%C3%A9a").unwrap(), "léa");
    assert_eq!(decode_uri_component("a+b").unwrap(), "a+b");
    assert!(decode_uri_component("%E0%A4%A").is_err());
    assert!(decode_uri_component("%C3").is_err());
}

#[test]
fn reads_query_parameters_as_url_search_params_does() {
    let request = Request::new("GET", "/api/voice/errand?job=a%20b+c&x=%zz");
    assert_eq!(request.path, "/api/voice/errand");
    assert_eq!(request.query_param("job").as_deref(), Some("a b c"));
    assert_eq!(request.query_param("x").as_deref(), Some("%zz"));
    assert_eq!(request.query_param("none"), None);
}

#[test]
fn parses_multipart_forms_their_files_apart() {
    let body = b"--xx\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nTom\r\n--xx\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"rec.wav\"\r\nContent-Type: audio/wav\r\n\r\nRI\r\nFF\r\n--xx--\r\n";
    let form = parse_form(Some("multipart/form-data; boundary=xx"), body).unwrap();
    assert_eq!(form.len(), 2);
    assert_eq!(form[0].text().as_deref(), Some("Tom"));
    assert_eq!(form[1].filename.as_deref(), Some("rec.wav"));
    assert_eq!(form[1].data, b"RI\r\nFF");
    assert_eq!(form[1].text(), None);
    assert!(parse_form(Some("application/json"), body).is_none());
    assert!(parse_form(None, body).is_none());
}
