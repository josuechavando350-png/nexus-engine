use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use worker::*;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = MAX_HTML_BYTES + 1024 * 1024;
const STREAM_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize)]
struct TransformPayload {
    html: String,
    vector: RouteVectorSnapshot,
    #[serde(default)]
    delivery_profile: DeliveryProfile,
}

#[derive(Debug, Default, Deserialize)]
struct DeliveryProfile {
    #[serde(default)]
    save_data: bool,
    #[serde(default)]
    ect: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RouteVectorSnapshot {
    suite: String,
    module_count: u16,
    site_id: String,
    route: String,
    version: u64,
    sections: BTreeMap<String, SectionSnapshot>,
    output_hash: String,
}

#[derive(Debug, Deserialize)]
struct SectionSnapshot {
    json_ld: Value,
    #[serde(default)]
    vector_profile: Value,
    #[serde(default)]
    module_evidence: Value,
    output_hash: String,
}

#[event(fetch)]
pub async fn main(mut req: Request, _env: Env, _ctx: worker::Context) -> Result<Response> {
    if req.method() != Method::Post || req.path() != "/transform" {
        return Response::error("not found", 404);
    }
    if let Some(length) = req.headers().get("content-length")? {
        if length.parse::<usize>().unwrap_or(MAX_REQUEST_BYTES + 1) > MAX_REQUEST_BYTES {
            return Response::error("payload too large", 413);
        }
    }

    let payload: TransformPayload = req
        .json()
        .await
        .map_err(|e| Error::RustError(format!("invalid transform payload: {e}")))?;
    if payload.html.len() > MAX_HTML_BYTES {
        return Response::error("html too large", 413);
    }
    validate_snapshot(&payload.vector)?;

    let graph = unified_graph(&payload.vector)?;
    // Strict fail-open requires the gateway to retain the pristine origin body.
    // Rust therefore uses lol_html as a streaming parser over 16 KiB chunks into
    // a shadow output buffer; bytes are committed to the client only after the
    // gateway's 4 ms Promise.race accepts the completed candidate.
    let output = rewrite_html_shadow_streaming(
        payload.html.as_bytes(),
        &graph,
        &payload.delivery_profile,
    )?;
    let headers = Headers::new();
    headers.set("content-type", "text/html; charset=utf-8")?;
    headers.set("x-nexus-seo-suite", "SEO_AVENGERS_200")?;
    headers.set("x-nexus-seo-transformer", "rust-wasm-lol-html/200")?;
    headers.set("x-nexus-seo-vector-version", &payload.vector.version.to_string())?;
    headers.set("x-nexus-seo-vector-hash", &payload.vector.output_hash)?;
    Ok(Response::from_bytes(output)?.with_headers(headers))
}

fn validate_snapshot(snapshot: &RouteVectorSnapshot) -> Result<()> {
    if snapshot.suite != "SEO_AVENGERS_200"
        || snapshot.module_count != 200
        || snapshot.site_id.trim().is_empty()
        || !snapshot.route.starts_with('/')
        || snapshot.version == 0
        || !snapshot.output_hash.starts_with("sha256:")
    {
        return Err(Error::RustError("invalid SEO AVENGERS 200 vector snapshot identity".into()));
    }
    for section in snapshot.sections.values() {
        if !section.output_hash.starts_with("sha256:") || !section.json_ld.is_object() {
            return Err(Error::RustError("invalid section vector".into()));
        }
        if !(section.vector_profile.is_null() || section.vector_profile.is_object()) {
            return Err(Error::RustError("invalid vector profile".into()));
        }
        if !(section.module_evidence.is_null() || section.module_evidence.is_object()) {
            return Err(Error::RustError("invalid module evidence".into()));
        }
    }
    Ok(())
}

fn unified_graph(snapshot: &RouteVectorSnapshot) -> Result<String> {
    // Multi-tenant invariant: no agency/global Organization is injected here.
    // Every semantic node comes from this exact site_id/route snapshot. Provider
    // entity links (Wikipedia/Wikidata/MID) are only present when the async NLP
    // worker grounded them; Rust never fabricates IDs.
    let mut graph: Vec<Value> = Vec::with_capacity(snapshot.sections.len());
    for section in snapshot.sections.values() {
        let mut node = section.json_ld.clone();
        if let Some(object) = node.as_object_mut() {
            object.remove("@context");
        }
        graph.push(node);
    }

    serde_json::to_string(&json!({
        "@context": "https://schema.org",
        "@graph": graph
    }))
    .map_err(|e| Error::RustError(e.to_string()))
}

fn safe_inline_json(raw: &str) -> String {
    // Prevent a provider/entity label from terminating the JSON-LD script tag.
    raw.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

fn rewrite_html_shadow_streaming(
    input: &[u8],
    json_ld: &str,
    delivery: &DeliveryProfile,
) -> Result<Vec<u8>> {
    let mut output = Vec::<u8>::with_capacity(input.len() + json_ld.len() + 512);
    let schema = format!(
        r#"<script type="application/ld+json" data-nexus-seo="avengers-200">{}</script>"#,
        safe_inline_json(json_ld)
    );
    let save_data = delivery.save_data;
    let ect = delivery
        .ect
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let constrained_network = save_data || matches!(ect.as_str(), "slow-2g" | "2g");

    let settings = Settings::new()
        .append_element_content_handler(element!("head", move |element| {
            element.append(&schema, ContentType::Html);
            Ok(())
        }))
        .append_element_content_handler(element!("img", move |element| {
            if element.get_attribute("decoding").is_none() {
                element.set_attribute("decoding", "async")?;
            }
            if element.get_attribute("fetchpriority").is_none() {
                element.set_attribute("fetchpriority", "auto")?;
            }
            if constrained_network
                && element.get_attribute("data-lcp").as_deref() != Some("true")
                && element.get_attribute("loading").is_none()
            {
                element.set_attribute("loading", "lazy")?;
            }
            Ok(())
        }))
        .append_element_content_handler(element!(r#"img[data-lcp="true"]"#, |element| {
            element.set_attribute("decoding", "async")?;
            element.set_attribute("fetchpriority", "high")?;
            element.set_attribute("loading", "eager")?;
            Ok(())
        }))
        .append_element_content_handler(element!("iframe", |element| {
            if element.get_attribute("loading").is_none() {
                element.set_attribute("loading", "lazy")?;
            }
            Ok(())
        }))
        // Conservative HTML5 cleanup only. We never remove arbitrary scripts,
        // styles, checkout/runtime code, headings or landmarks.
        .append_element_content_handler(element!(r#"script[type="text/javascript"]"#, |element| {
            element.remove_attribute("type");
            Ok(())
        }))
        .append_element_content_handler(element!(r#"style[type="text/css"]"#, |element| {
            element.remove_attribute("type");
            Ok(())
        }))
        .append_element_content_handler(element!(r#"link[rel="stylesheet"][type="text/css"]"#, |element| {
            element.remove_attribute("type");
            Ok(())
        }));

    let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| output.extend_from_slice(chunk));
    for chunk in input.chunks(STREAM_CHUNK_BYTES) {
        rewriter
            .write(chunk)
            .map_err(|e| Error::RustError(format!("lol_html write failed: {e}")))?;
    }
    rewriter
        .end()
        .map_err(|e| Error::RustError(format!("lol_html end failed: {e}")))?;
    drop(rewriter);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_old_or_invalid_snapshot() {
        let snapshot = RouteVectorSnapshot {
            suite: "SEO_AVENGERS_50".into(),
            module_count: 50,
            site_id: "nexus".into(),
            route: "/".into(),
            version: 1,
            sections: BTreeMap::new(),
            output_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        };
        assert!(validate_snapshot(&snapshot).is_err());
    }

    #[test]
    fn streams_and_marks_lcp_without_reordering_semantics() {
        let input = br#"<!doctype html><html><head></head><body><main><h1>Nexus</h1><img data-lcp="true" src="hero.webp"><img src="later.webp"></main></body></html>"#;
        let output = rewrite_html_shadow_streaming(
            input,
            r#"{"@context":"https://schema.org","@graph":[]}"#,
            &DeliveryProfile::default(),
        )
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("data-nexus-seo=\"avengers-200\""));
        assert!(text.contains("fetchpriority=\"high\""));
        assert!(text.contains("<h1>Nexus</h1>"));
    }
}
